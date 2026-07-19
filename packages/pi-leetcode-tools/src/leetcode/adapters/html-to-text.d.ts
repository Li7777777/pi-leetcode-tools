declare module "html-to-text" {
  export interface HtmlToTextOptions {
    wordwrap?: number | false;
    preserveNewlines?: boolean;
    selectors?: Array<{
      selector: string;
      format?: string;
      options?: Record<string, unknown>;
    }>;
    limits?: {
      maxInputLength?: number;
      maxChildNodes?: number;
      maxDepth?: number;
    };
  }

  export function convert(html: string, options?: HtmlToTextOptions): string;
}
