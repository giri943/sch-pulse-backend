import sanitizeHtml from "sanitize-html";

// Colors (named, #hex, or rgb/rgba) — used by the color + highlight marks.
const COLOR = [/^#(0x)?[0-9a-fA-F]{3,8}$/, /^rgba?\(\s*[\d.,\s%]+\)$/, /^[a-zA-Z]+$/];

/**
 * Sanitize rich-text incident notes (TipTap HTML) to a safe allowlist before
 * storing — prevents stored XSS even if a crafted payload is PATCHed directly.
 * Allows the full set of formatting the editor produces: marks, colors/highlight,
 * lists + checklists, links, images (http/https only — no base64), tables, and
 * @-mention spans. Inline styles are restricted to color/background/align/width.
 */
export function sanitizeNoteHtml(html: string | undefined | null): string {
  if (!html) return "";
  return sanitizeHtml(html, {
    allowedTags: [
      "p", "br", "hr", "strong", "b", "em", "i", "u", "s", "strike", "mark",
      "code", "pre", "blockquote", "ul", "ol", "li",
      "h1", "h2", "h3", "h4", "a", "span", "div", "label", "input", "img",
      "table", "thead", "tbody", "tr", "th", "td", "colgroup", "col",
    ],
    allowedAttributes: {
      a: ["href", "target", "rel"],
      img: ["src", "alt", "title", "width", "height"],
      // TipTap mention node + color/highlight spans.
      span: ["data-type", "data-id", "data-label", "class", "style"],
      mark: ["data-color", "class", "style"],
      p: ["style"],
      h1: ["style"], h2: ["style"], h3: ["style"], h4: ["style"],
      // Task lists render as <ul data-type="taskList"><li data-type="taskItem" data-checked>…
      ul: ["data-type"],
      li: ["data-type", "data-checked"],
      input: ["type", "checked", "disabled"],
      div: ["data-type"],
      // Tables (with resizable column widths).
      table: ["style"],
      col: ["style"],
      td: ["colspan", "rowspan", "colwidth", "style"],
      th: ["colspan", "rowspan", "colwidth", "style"],
    },
    allowedStyles: {
      "*": {
        color: COLOR,
        "background-color": COLOR,
        "text-align": [/^(left|right|center|justify)$/],
        width: [/^\d+(\.\d+)?(px|%)$/],
      },
    },
    // http/https/mailto only — notably excludes data: so base64 images can't be embedded.
    allowedSchemes: ["http", "https", "mailto"],
    // Force checkboxes read-only (they reflect state; editing happens in the app).
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer", target: "_blank" }),
      input: sanitizeHtml.simpleTransform("input", { type: "checkbox", disabled: "disabled" }),
    },
  });
}

/** True when a note has no real content (empty, or just empty tags/whitespace). */
export function isEmptyNote(html: string | undefined | null): boolean {
  if (!html) return true;
  // An image or a checklist counts as content even with no text.
  if (/<(img|input|table)\b/i.test(html)) return false;
  return html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim().length === 0;
}
