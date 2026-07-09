import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from "react";

export function Table({ className = "", ...props }: HTMLAttributes<HTMLTableElement>) {
  return <table className={`w-full caption-bottom text-sm ${className}`} {...props} />;
}

export function TableHeader({ className = "", ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={`border-b ${className}`} {...props} />;
}

export function TableBody({ className = "", ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={className} {...props} />;
}

export function TableRow({ className = "", ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={`border-b transition-colors hover:bg-muted/50 last:border-0 ${className}`} {...props} />;
}

export function TableHead({ className = "", ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th className={`h-10 px-3 text-left align-middle font-medium text-muted-foreground ${className}`} {...props} />;
}

export function TableCell({ className = "", ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={`px-3 py-2.5 align-middle ${className}`} {...props} />;
}
