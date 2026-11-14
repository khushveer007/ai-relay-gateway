import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon } from "lucide-react"

// Dark-only dashboard: the theme is fixed, so no theme provider is needed. Toasts are transient
// and carry no loading state (UI-SPEC), so there is no `loading` icon.
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="dark"
      className="toaster group"
      visibleToasts={3}
      duration={3600}
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
      }}
      style={
        {
          "--normal-bg": "var(--card)",
          "--normal-text": "var(--foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "bg-card text-foreground border-border break-words",
          error: "border-l-4 border-l-status-danger",
          success: "border-l-4 border-l-status-ok",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
