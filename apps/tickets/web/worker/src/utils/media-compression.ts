/**
 * Media compression adapter boundary.
 *
 * Defines the compression interface and provides a no-op default.
 * Future providers (external transcoding API, background job, Cloudflare Stream)
 * implement this interface without changing callers.
 *
 * Currently returns null for all operations — no compression is performed.
 * This is a boundary for future work (see issue #74).
 */

export interface CompressionOptions {
  maxWidth?: number;
  maxHeight?: number;
  quality?: number; // 0-100
}

export interface CompressionResult {
  data: ArrayBuffer;
  contentType: string;
  size: number;
}

export interface CompressionProvider {
  /** Compress/re-encode an image. Returns null if no compression is possible. */
  compressImage(
    input: ArrayBuffer,
    contentType: string,
    options?: CompressionOptions
  ): Promise<CompressionResult | null>;
  /** Compress/re-encode a video. Returns null if no compression is possible. */
  compressVideo(
    input: ArrayBuffer,
    contentType: string,
    options?: CompressionOptions
  ): Promise<CompressionResult | null>;
}

/** No-op provider — all operations return null.
 *  Replace with an actual implementation when a compression backend is available. */
const noopProvider: CompressionProvider = {
  async compressImage() {
    return null;
  },
  async compressVideo() {
    return null;
  },
};

// Future provider registration point:
//   import { r2CompressionProvider } from "./r2-compression";
//   let active: CompressionProvider = r2CompressionProvider;

let activeProvider: CompressionProvider = noopProvider;

export function getActiveCompressionProvider(): CompressionProvider {
  return activeProvider;
}

/** For testing: inject a custom provider. */
export function _setCompressionProvider(provider: CompressionProvider): void {
  activeProvider = provider;
}
