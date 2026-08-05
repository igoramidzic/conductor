import { Activity, CircleDot, LayoutDashboard } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const navigation = [
  { label: "Overview", icon: LayoutDashboard, active: true },
  { label: "Activity", icon: Activity, active: false },
];

function AppSidebar() {
  return (
    <Sidebar collapsible="offcanvas">
      <SidebarHeader className="h-12 shrink-0 border-b border-border p-0" />
      <SidebarContent className="pt-2">
        <SidebarGroup>
          <SidebarGroupLabel className="font-mono text-[10px] tracking-[0.12em] uppercase">
            Workspace
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navigation.map((item) => (
                <SidebarMenuItem key={item.label}>
                  <SidebarMenuButton
                    isActive={item.active}
                    tooltip={item.label}
                  >
                    <item.icon />
                    <span>{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="gap-0 px-4 py-3">
        <span className="font-mono text-[10px] tracking-[0.08em] text-sidebar-foreground/55 uppercase">
          Local workspace
        </span>
      </SidebarFooter>
    </Sidebar>
  );
}

function FloatingSidebarTrigger() {
  const isMac = window.electron.platform === "darwin";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarTrigger
            className={cn(
              "app-no-drag fixed top-2.5 z-50 pointer-events-auto text-foreground/70 hover:bg-foreground/[0.06] hover:text-foreground",
              isMac ? "left-[84px]" : "left-3",
            )}
          />
        }
      />
      <TooltipContent side="bottom" sideOffset={8}>
        Toggle sidebar
      </TooltipContent>
    </Tooltip>
  );
}

function WorkspaceHeader() {
  const { state } = useSidebar();
  const isMac = window.electron.platform === "darwin";

  return (
    <header className="relative h-12 shrink-0 border-b bg-card/95">
      <div
        className={cn(
          "app-drag absolute inset-y-0 right-0",
          state === "collapsed"
            ? isMac
              ? "left-[120px]"
              : "left-12"
            : "left-0",
        )}
      />
      <p
        className={cn(
          "pointer-events-none fixed top-0 z-40 flex h-12 items-center text-[13px] leading-none font-medium tracking-[-0.01em] transition-[left] duration-200 ease-linear motion-reduce:transition-none",
          state === "collapsed"
            ? isMac
              ? "left-[128px]"
              : "left-14"
            : "left-[calc(var(--sidebar-width)+1rem)]",
        )}
      >
        Hello world
      </p>
    </header>
  );
}

function Workspace() {
  return (
    <SidebarInset className="min-w-0 overflow-hidden">
      <WorkspaceHeader />
      <section className="flex flex-1 items-start overflow-auto p-6 sm:p-8 lg:p-10">
        <Card
          size="sm"
          className="w-full max-w-xl shadow-[0_1px_2px_rgb(20_30_45/0.04)]"
        >
          <CardHeader>
            <div className="mb-3 flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <CircleDot className="size-4" aria-hidden="true" />
            </div>
            <CardTitle>Hello world</CardTitle>
            <CardDescription>
              Your Conductor workspace is ready for its first feature.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-xs leading-5 text-muted-foreground">
              Use the floating control above or press <kbd>⌘B</kbd> to make room
              for the work ahead.
            </p>
          </CardContent>
        </Card>
      </section>
    </SidebarInset>
  );
}

export function App() {
  return (
    <TooltipProvider delay={300}>
      <SidebarProvider
        className="h-svh min-h-0 overflow-hidden"
        style={{ "--sidebar-width": "15rem" } as React.CSSProperties}
      >
        <AppSidebar />
        <Workspace />
        <FloatingSidebarTrigger />
      </SidebarProvider>
    </TooltipProvider>
  );
}
