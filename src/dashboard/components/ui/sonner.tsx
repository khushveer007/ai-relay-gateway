import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon } from "lucide-react"
import { useIsDesktop } from "@/hooks/use-media-query"

// Dark-only dashboard: the theme is fixed, so no theme provider is needed. Toasts are transient
// and carry no loading state (UI-SPEC), so there is no `loading` icon.
//
// Below 768px the bottom bar is showing, so toasts sit above it. Sonner switches to its mobile layout
// at 600px, so mobileOffset alone would leave 600 to 767px behind the bar: both offsets are set.
const BAR_CLEARANCE = { bottom: "calc(4.5rem + env(safe-area-inset-bottom))" }

const Toaster = ({ ...props }: ToasterProps) => {
  const isDesktop = useIsDesktop()
  return (
    <Sonner
      {...(isDesktop ? {} : { offset: BAR_CLEARANCE, mobileOffset: BAR_CLEARANCE })}
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
