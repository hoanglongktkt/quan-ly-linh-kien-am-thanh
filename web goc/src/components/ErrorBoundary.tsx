import React from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';

type Props = {
  children: React.ReactNode;
  /** Tên vùng hiển thị khi lỗi (VD: Dashboard, Quản lý đơn) */
  label?: string;
};

type State = {
  error: Error | null;
};

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[ErrorBoundary${this.props.label ? `: ${this.props.label}` : ''}]`, error, info);
  }

  private handleRetry = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return (
        <div className="p-6 rounded-2xl border border-rose-200 bg-rose-50/90 text-center space-y-3">
          <AlertCircle className="w-10 h-10 text-rose-600 mx-auto" />
          <p className="text-sm font-bold text-rose-900">
            {this.props.label ? `${this.props.label} gặp lỗi` : 'Phần giao diện này gặp lỗi'}
          </p>
          <p className="text-xs text-rose-700 break-words max-w-md mx-auto">
            {this.state.error.message || 'Lỗi render không xác định'}
          </p>
          <button
            type="button"
            onClick={this.handleRetry}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-white border border-rose-200 text-rose-800 text-xs font-bold hover:bg-rose-100"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Thử tải lại vùng này
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
