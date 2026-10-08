import * as React from "react";
import { Button } from "@/components/ui/button";

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error("ErrorBoundary caught", error, info.componentStack);
  }

  reset = (): void => this.setState({ error: null });

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div role="alert" className="flex min-h-[40vh] flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-base font-semibold">Something went wrong</p>
          <p className="text-sm text-muted-foreground">{this.state.error.message}</p>
          <Button onClick={this.reset} size="sm">
            Try again
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}
