import { clsx } from "clsx";
import { forwardRef } from "react";

interface TableProps {
  children: React.ReactNode;
  className?: string;
}

export const Table = forwardRef<HTMLTableElement, TableProps>(({ children, className = "" }, ref) => (
  <div className="overflow-x-auto">
    <table ref={ref} className={clsx("w-full text-sm", className)}>{children}</table>
  </div>
));

Table.displayName = "Table";

export function TableHeader({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <thead className={clsx("[&_tr]:border-b", className)}>{children}</thead>;
}

export function TableBody({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <tbody className={clsx("[&_tr:last-child]:border-0", className)}>{children}</tbody>;
}

export function TableRow({ children, className = "", ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={clsx("border-b border-gray-200 dark:border-slate-800 hover:bg-gray-50 dark:hover:bg-slate-800/50", className)} {...props} />;
}

export function TableHead({ children, className = "", ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th className={clsx("text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400", className)} {...props}>
      {children}
    </th>
  );
}

export function TableCell({ children, className = "", ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={clsx("px-4 py-3 text-gray-900 dark:text-white", className)} {...props}>{children}</td>;
}
