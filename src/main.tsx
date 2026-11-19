import { Component, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

class EinkErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, message: '' };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      message: error?.message || String(error),
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('E-Ink Dashboard render error:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="h-screen w-screen bg-white text-black p-6 flex flex-col justify-center gap-4 overflow-auto">
          <h1 className="text-xl font-black border-b-2 border-black pb-2">
            電子紙時鐘畫面載入異常
          </h1>
          <p className="text-sm font-bold break-words">{this.state.message}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="px-4 py-2 font-black border-2 border-black rounded bg-black text-white cursor-pointer"
            >
              重新載入
            </button>
            <button
              type="button"
              onClick={() => {
                try {
                  localStorage.clear();
                } catch {
                  // ignore
                }
                window.location.reload();
              }}
              className="px-4 py-2 font-black border-2 border-black rounded bg-white text-black cursor-pointer"
            >
              清除本機設定並重試
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <EinkErrorBoundary>
    <App />
  </EinkErrorBoundary>
);
