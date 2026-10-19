import type { ComponentType, Ref } from 'react';
import { WebView as RNWebView, type WebViewProps } from 'react-native-webview';

/** The methods the app calls on a WebView. */
export interface WebViewHandle {
  injectJavaScript: (script: string) => void;
}

/**
 * react-native-webview 14 declares `class WebView<P = undefined> extends Component<WebViewProps & P>`, which
 * TypeScript reduces to `never` props; this alias restores the intended prop types.
 */
export const WebView = RNWebView as unknown as ComponentType<WebViewProps & { ref?: Ref<WebViewHandle> }>;
export type { WebViewMessageEvent } from 'react-native-webview';
