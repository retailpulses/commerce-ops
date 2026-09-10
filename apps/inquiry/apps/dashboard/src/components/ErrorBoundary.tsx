import { Component } from "react";
import Button from "./ui/Button";

interface Props {
  children: React.ReactNode;
  /** Change this key to remount the boundary (clears the error state) */
  resetKey?: string | number | null;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary] Caught render error:", error);
    console.error("[ErrorBoundary] Component stack:", info.componentStack);
  }

  componentDidUpdate(prevProps: Props) {
    if (this.props.resetKey !== prevProps.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  handleRetry = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full items-center justify-center p-6">
          <div className="flex max-w-sm flex-col items-center text-center">
            <svg
              className="mb-3 h-8 w-8 text-red-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"
              />
            </svg>
            <h3 className="mb-1 text-sm font-medium text-gray-900">
              Failed to load inquiry details
            </h3>
            <p className="mb-4 text-xs text-gray-500">
              {this.state.error.message || "An unexpected error occurred."}
            </p>
            <Button variant="secondary" size="sm" onClick={this.handleRetry}>
              Retry
            </Button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
