// A browser preview has no desktop window privileges.
export function getCurrentWindow(): never { throw new Error("Design preview has no native window"); }
