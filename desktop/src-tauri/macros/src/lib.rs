//! Internal proc-macros for cc-bridge.
//!
//! `ToolSchema` derive generates an inherent `schema()` method on a `serde::Deserialize`
//! struct/enum that returns its JSON Schema (draft-07-ish) as `serde_json::Value`. This lets
//! `mcp/tools/registry.rs` build the MCP `tools/list` `inputSchema` directly from the
//! strongly-typed `XxxArgs` structs — eliminating the hand-written `json!` blocks and the
//! field-drift between args and schema.
//!
//! NOTE: this crate is `proc-macro = true` and only runs at compile time; it contributes
//! nothing to the shipped `cc-bridge-desktop.exe` (honors the binary-size budget in CLAUDE.md).

use proc_macro::TokenStream;
use quote::quote;
use syn::{
    parse_macro_input, Data, DeriveInput, Fields, GenericArgument, PathArguments, Type,
};

#[proc_macro_derive(ToolSchema)]
pub fn derive_tool_schema(input: TokenStream) -> TokenStream {
    let ast = parse_macro_input!(input as DeriveInput);
    let name = &ast.ident;
    let body = match &ast.data {
        Data::Struct(s) => gen_object_schema(&s.fields),
        Data::Enum(e) => {
            let mut variants = Vec::new();
            for v in &e.variants {
                let vschema = match &v.fields {
                    Fields::Unit => quote! { ::serde_json::json!({"type": "string"}) },
                    Fields::Named(_) => gen_object_schema(&v.fields),
                    Fields::Unnamed(u) => {
                        // Tuple variant: use the first field's schema.
                        let ty = &u.unnamed[0].ty;
                        type_schema(ty)
                    }
                };
                variants.push(vschema);
            }
            quote! {
                {
                    let variants: Vec<::serde_json::Value> = vec![ #(#variants),* ];
                    ::serde_json::json!({ "oneOf": variants })
                }
            }
        }
        Data::Union(_) => quote! { ::serde_json::json!({}) },
    };
    let expanded = quote! {
        impl #name {
            #[allow(dead_code, clippy::derive_partial_eq_without_eq)]
            pub fn schema() -> ::serde_json::Value {
                #body
            }
        }
    };
    expanded.into()
}

/// Build an object schema `{type:object, properties:{...}, required:[...]}` from named fields.
fn gen_object_schema(fields: &Fields) -> proc_macro2::TokenStream {
    let named = match fields {
        Fields::Named(n) => n,
        _ => return quote! { ::serde_json::json!({"type": "object"}) },
    };
    let mut inserts = Vec::new();
    let mut req_pushes = Vec::new();
    for f in &named.named {
        let field_name = f.ident.as_ref().unwrap();
        let prop_name = get_rename(f).unwrap_or_else(|| field_name.to_string());
        let prop_lit = syn::LitStr::new(&prop_name, field_name.span());
        let schema_expr = type_schema(&f.ty);
        let is_option = is_option_type(&f.ty);
        let has_default = has_serde_default(f);
        if !(is_option || has_default) {
            req_pushes.push(quote! {
                required.push(#prop_lit.to_string());
            });
        }
        inserts.push(quote! {
            properties.insert(#prop_lit.to_string(), #schema_expr);
        });
    }
    quote! {
        {
            let mut properties = ::serde_json::Map::new();
            let mut required: Vec<String> = Vec::new();
            #( #inserts )*
            #( #req_pushes )*
            ::serde_json::json!({
                "type": "object",
                "properties": properties,
                "required": required,
            })
        }
    }
}

/// Map a Rust type to a JSON Schema value expression.
fn type_schema(ty: &Type) -> proc_macro2::TokenStream {
    match ty {
        Type::Path(tp) => {
            let seg = match tp.path.segments.last() {
                Some(s) => s,
                None => return quote! { ::serde_json::json!({}) },
            };
            let ident = seg.ident.to_string();
            match ident.as_str() {
                "String" => quote! { ::serde_json::json!({"type": "string"}) },
                "bool" => quote! { ::serde_json::json!({"type": "boolean"}) },
                "u8" | "u16" | "u32" | "u64" | "usize" | "i8" | "i16" | "i32" | "i64" | "isize" => {
                    quote! { ::serde_json::json!({"type": "integer"}) }
                }
                "f32" | "f64" => quote! { ::serde_json::json!({"type": "number"}) },
                // serde_json::Value → unconstrained.
                "Value" => quote! { ::serde_json::json!({}) },
                "Option" => {
                    let inner = first_generic_type(seg);
                    type_schema(&inner)
                }
                "Vec" => {
                    let inner = first_generic_type(seg);
                    let inner_expr = type_schema(&inner);
                    quote! { ::serde_json::json!({"type": "array", "items": #inner_expr, "minItems": 1}) }
                }
                // Any other (custom struct/enum): call its inherent `schema()`.
                _ => quote! { #tp::schema() },
            }
        }
        _ => quote! { ::serde_json::json!({}) },
    }
}

fn get_rename(f: &syn::Field) -> Option<String> {
    for attr in &f.attrs {
        if attr.path().is_ident("serde") {
            let mut rename = None;
            let _ = attr.parse_nested_meta(|m| {
                if m.path.is_ident("rename") {
                    if let Ok(s) = m.value().and_then(|v| v.parse::<syn::LitStr>()) {
                        rename = Some(s.value());
                    }
                }
                Ok(())
            });
            if rename.is_some() {
                return rename;
            }
        }
    }
    None
}

fn is_option_type(ty: &Type) -> bool {
    if let Type::Path(tp) = ty {
        if let Some(seg) = tp.path.segments.last() {
            return seg.ident == "Option";
        }
    }
    false
}

fn has_serde_default(f: &syn::Field) -> bool {
    for attr in &f.attrs {
        if attr.path().is_ident("serde") {
            let mut found = false;
            let _ = attr.parse_nested_meta(|m| {
                if m.path.is_ident("default") {
                    found = true;
                }
                Ok(())
            });
            if found {
                return true;
            }
        }
    }
    false
}

fn first_generic_type(seg: &syn::PathSegment) -> Type {
    if let PathArguments::AngleBracketed(ab) = &seg.arguments {
        for arg in &ab.args {
            if let GenericArgument::Type(t) = arg {
                return t.clone();
            }
        }
    }
    syn::parse_quote! { ::serde_json::Value }
}
