import { React, html } from "../../../lib/html.js";
import { MarkdownRenderer } from "./markdown-renderer.js";
import { ToolActivity } from "./tool-activity.js";
import { Avatar } from "./avatar.js";
import { AttachmentPreviewModal } from "./attachment-preview.js";
import { ProjectFileChips } from "./project-file-chips.js";
import { Icon } from "../../../design-system/icons.js";
import { Popover } from "../../../design-system/popover.js";
import { useT } from "../../../lib/i18n.js";
import { toast } from "../../../lib/toast.js";
import { isDesktopRuntime } from "../../../lib/api.js";
import { saveBlob } from "../../../lib/save-file.js";
import {
  buildDocxBlob,
  buildPdfBlob,
  collectMermaidExportImages,
  copyWorkProduct,
  downloadDocx,
  downloadHtml,
  downloadJson,
  downloadMarkdown,
  downloadPdf,
} from "../lib/work-product-export.js";
import {
  openSavedWorkProduct,
  saveAssistantResponseToWork,
  saveGeneratedFileArtifactToWork,
} from "../lib/work-product-save.js";
import { buildThreadJsonExport, buildThreadMarkdownExport } from "../lib/thread-export.js";
import {
  buildGeneratedFileBlob,
  generatedFileArtifactsForMessage,
  generatedFileKindLabel,
  generatedFilePreviewAttachment,
} from "../lib/generated-file-artifacts.js";

// `typeof isDesktopRuntime === 'function'` guards the runtime read so the
// component renders under the import-stripping unit harness; the reconciled
// test injects `isDesktopRuntime: () => true` to exercise the desktop path.
// On the web build this stays false, so the generated-work-product / file-chip
// rendering (which pulls the desktop-only export + save-file + project-file
// libraries) never mounts and the bubble stays the lean mono document view.
function desktopWorkProductEnabled() {
  return typeof isDesktopRuntime === "function" && isDesktopRuntime();
}

/* Bicolor attribution (DESIGN.md): signal blue is the user's hand and gold is
   reserved for agent provenance, approvals, receipts, and generated work.
   User turns stay in a restrained blue bubble; plain assistant prose stays
   borderless and document-like; generated work gets the gold artifact panel.
   System / error stay as centered notices on neutral v2 surfaces, never the
   warning accent (see chat-design-contract.test). */
const ROLE_STYLES = {
  user: "ml-auto rounded-[18px] border border-signal/25 bg-signal/10 px-4 py-3 text-iron-100",
  assistant: "mr-auto text-iron-100",
  assistantWorkProduct:
    "mr-auto w-full max-w-full rounded-[16px] border border-[color-mix(in_srgb,var(--v2-gold)_26%,var(--v2-panel-border))] bg-[var(--v2-card-bg)] px-5 py-4 text-iron-100 shadow-[var(--v2-card-shadow)]",
  system:
    "mx-auto rounded-[18px] border border-[var(--v2-panel-border)] bg-[var(--v2-surface-soft)] px-4 py-3 text-center text-[var(--v2-text-muted)]",
  error:
    "mx-auto rounded-[18px] border border-[color-mix(in_srgb,var(--v2-danger-text)_32%,var(--v2-panel-border))] bg-[var(--v2-danger-soft)] px-4 py-3 text-center text-[var(--v2-danger-text)]",
};
const COMPACT_ATTACHMENT_LIMIT = 3;

function formatTimestamp(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function messageContentForDisplay({ role, content, attachments }) {
  const text = content == null ? "" : String(content);
  if (text.trim()) return text;
  if (role === "user" && Array.isArray(attachments) && attachments.length > 0) {
    return attachments.length === 1
      ? "Sent 1 attachment"
      : `Sent ${attachments.length} attachments`;
  }
  return text;
}

function assistantResponseLooksLikeWorkProduct(role, content) {
  if (role !== "assistant") return false;
  const text = String(content || "").trim();
  if (!text) return false;
  const hasHeading = /^#{1,3}\s+\S/m.test(text) || /\n#{1,3}\s+\S/m.test(text);
  const hasRealTable = /^\|.*\|\n\s*\|[\s:|-]+\|/m.test(text);
  return hasHeading || hasRealTable;
}

function messageShellClass(isUser, isAssistantWorkProduct) {
  return [
    "flex min-w-0 flex-col gap-1",
    isAssistantWorkProduct
      ? "w-full max-w-[min(860px,92vw)]"
      : isUser
        ? "max-w-[min(680px,86vw)]"
        : "max-w-[min(760px,92vw)]",
    isUser ? "items-end" : "items-start",
  ].join(" ");
}

function messageOuterClass(isUser, isAssistantWorkProduct) {
  return [
    "group flex flex-col",
    isAssistantWorkProduct ? "w-full" : "",
    isUser ? "items-end" : "items-start",
  ].join(" ");
}

function messageBodyClass(role, isOptimistic, isAssistantWorkProduct) {
  return [
    // Mono is canonical for web: keep the readable document size (see
    // message-bubble.test "readable typography"), not the compact desktop size.
    "text-base leading-7",
    isAssistantWorkProduct
      ? ROLE_STYLES.assistantWorkProduct
      : ROLE_STYLES[role] || ROLE_STYLES.assistant,
    isOptimistic ? "opacity-70" : "",
  ].join(" ");
}

function attachmentEvidenceLabel(att = {}) {
  const status = String(att.extraction_status || "");
  if (att.extractedText || att.embedded_text) {
    return status === "extracted_text_truncated"
      ? "Model-read text retained, truncated"
      : "Model-read text retained";
  }
  if (att.modelReadable === true) return "Model-readable payload retained";
  if (status === "content_omitted_message_budget") return "Sent as file metadata";
  if (status === "extracted_text_truncated") return "Preview text truncated";
  return "Attachment sent";
}

function shouldCompactAttachmentStack(role, attachments) {
  return (
    role === "user" && Array.isArray(attachments) && attachments.length > COMPACT_ATTACHMENT_LIMIT
  );
}

function visibleAttachmentsForMessage(role, attachments, expanded = false) {
  const list = Array.isArray(attachments) ? attachments : [];
  if (!shouldCompactAttachmentStack(role, list) || expanded) return list;
  return list.slice(0, COMPACT_ATTACHMENT_LIMIT);
}

function attachmentStackSummary(attachments = []) {
  const list = Array.isArray(attachments) ? attachments : [];
  const readable = list.filter(
    (att) => att?.extractedText || att?.embedded_text || att?.modelReadable === true
  ).length;
  if (readable === list.length && list.length > 0) return "All files have model-readable text";
  if (readable > 0) return `${readable} files have model-readable text`;
  return "File metadata retained";
}

function attachmentStackClass(compact = false) {
  return compact
    ? "mt-2 flex flex-col gap-1.5 rounded-[14px] border border-signal/20 bg-white/5 p-2"
    : "mt-2 flex flex-col gap-1.5";
}

function imageAttachmentDataUrl(attachment = {}) {
  const directUrl = String(
    attachment.dataUrl || attachment.data_url || attachment.url || attachment.src || ""
  ).trim();
  const mimeType = String(attachment.mime_type || attachment.content_type || "").toLowerCase();
  if (/^(data:image\/|blob:)/i.test(directUrl)) return directUrl;
  if (/^https?:\/\//i.test(directUrl) && mimeType.startsWith("image/")) return directUrl;

  const base64 = String(attachment.data_base64 || attachment.base64 || "").replace(/\s+/g, "");
  if (!mimeType.startsWith("image/") || !base64) return "";
  return `data:${mimeType};base64,${base64}`;
}

function imagePreviewsForMessage({ images, attachments } = {}) {
  const previews = [];
  const seen = new Set();
  const pushPreview = (src, filename = "", index = previews.length) => {
    const cleanSrc = String(src || "").trim();
    if (!cleanSrc || seen.has(cleanSrc)) return;
    seen.add(cleanSrc);
    previews.push({
      src: cleanSrc,
      filename,
      alt: filename ? `Attached image: ${filename}` : `Attached image ${index + 1}`,
    });
  };

  for (const [index, image] of (Array.isArray(images) ? images : []).entries()) {
    if (typeof image === "string") {
      pushPreview(image, "", index);
    } else if (image && typeof image === "object") {
      pushPreview(
        image.dataUrl || image.data_url || image.url || image.src,
        image.filename || image.name || "",
        index
      );
    }
  }

  for (const [index, attachment] of (Array.isArray(attachments) ? attachments : []).entries()) {
    pushPreview(imageAttachmentDataUrl(attachment), attachment?.filename || "", index);
  }

  return previews;
}

function fileAttachmentsForMessage(attachments = []) {
  return (Array.isArray(attachments) ? attachments : []).filter(
    (attachment) => !imageAttachmentDataUrl(attachment)
  );
}

function imageThumbnailStripClass(isUser) {
  return ["flex max-w-full flex-wrap gap-2", isUser ? "justify-end" : "justify-start"].join(" ");
}

/* Collapsible provider-reasoning summary. Collapsed by default so the
   thread stays clean; expands to the full reasoning markdown. Data comes
   from the `thinking` projection item (PR #4230). */
function ThinkingDisclosure({ content }) {
  const [open, setOpen] = React.useState(false);
  if (!content) return null;
  return html`
    <div className="flex flex-col items-start">
      <button
        type="button"
        onClick=${() => setOpen((v) => !v)}
        aria-expanded=${open ? "true" : "false"}
        className="v2-button inline-flex items-center gap-1.5 border-0 bg-transparent px-1 py-1 text-xs font-medium text-iron-400 hover:text-iron-200"
      >
        <${Icon} name="spark" className="h-3.5 w-3.5" />
        <span>${open ? "Hide reasoning" : "Reasoning"}</span>
        <${Icon} name="chevron" className=${["h-3 w-3", open ? "rotate-180" : ""].join(" ")} />
      </button>
      ${open &&
      html`
        <div className="mt-1 border-l-2 border-white/10 pl-3 text-iron-300">
          <${MarkdownRenderer} content=${content} className="text-[13px]" />
        </div>
      `}
    </div>
  `;
}

function MessageBubbleImpl({ message, messages = [], onRetry, threadId }) {
  const {
    role,
    content,
    images,
    attachments,
    generatedImages,
    isOptimistic,
    status,
    error,
    toolCalls,
    timestamp,
  } = message;
  const isUser = role === "user";
  const t = useT();
  const desktopWorkProduct = desktopWorkProductEnabled();
  const [copied, setCopied] = React.useState(false);
  const [attachmentsExpanded, setAttachmentsExpanded] = React.useState(false);
  // Hook order: declared with the other hooks, before every role-based early
  // return below (see the crash note on `copy`).
  const [attachmentPreview, setAttachmentPreview] = React.useState(null);
  const [generatedFilePreview, setGeneratedFilePreview] = React.useState(null);
  // All hooks must run before the role-based early returns below. A message can
  // change role in place across renders (e.g. an optimistic bubble upgrading,
  // or a streaming role shift), so declaring `copy` after the early returns
  // made the hook count jump between renders and crashed the thread with
  // "Rendered more hooks than during the previous render". Keep every hook here.
  const copy = React.useCallback(async () => {
    try {
      // copyWorkProduct preserves markdown fidelity on desktop; on web the
      // plain clipboard write is enough.
      if (desktopWorkProduct) {
        await copyWorkProduct(typeof content === "string" ? content : "");
      } else {
        await navigator.clipboard.writeText(typeof content === "string" ? content : "");
      }
      setCopied(true);
      toast("Copied to clipboard", { tone: "success" });
      setTimeout(() => setCopied(false), 1400);
    } catch {
      toast("Copy failed", { tone: "error" });
    }
  }, [content, desktopWorkProduct]);

  if (role === "tool_activity" || (toolCalls && toolCalls.length > 0)) {
    const activity =
      toolCalls && toolCalls.length > 0
        ? {
            id: message.id,
            toolCalls,
          }
        : message;
    return html`<${ToolActivity} activity=${activity} />`;
  }

  if (role === "thinking") {
    return html`<${ThinkingDisclosure} content=${content} />`;
  }

  if (role === "image") {
    const imgs = generatedImages || [];
    return html`
      <div className="flex">
        <div className="flex flex-wrap gap-2">
          ${imgs.map((img, i) =>
            img.data_url
              ? html`<img
                  key=${i}
                  src=${img.data_url}
                  className="max-h-64 rounded-lg border border-iron-700 object-cover"
                  alt="Generated result"
                />`
              : html`
                  <div
                    key=${i}
                    className="rounded-lg border border-iron-700 bg-iron-900/70 px-4 py-3 text-sm text-iron-200"
                  >
                    <div>Generated image unavailable in history payload</div>
                    ${img.path &&
                    html`<div className="mt-1 font-mono text-xs text-iron-300">${img.path}</div>`}
                  </div>
                `
          )}
        </div>
      </div>
    `;
  }

  const timeLabel = formatTimestamp(timestamp);
  const showActions = (role === "assistant" || role === "user") && !isOptimistic;
  const displayContent = messageContentForDisplay({ role, content, attachments });
  // Generated work-product treatment depends on the desktop-only export +
  // save-file + artifact libraries, so it is gated by the runtime. On web the
  // assistant prose just renders as a plain document.
  const generatedFileArtifacts = desktopWorkProduct ? generatedFileArtifactsForMessage(message) : [];
  const hasGeneratedFiles = generatedFileArtifacts.length > 0;
  const isAssistantMarkdownWorkProduct =
    desktopWorkProduct && assistantResponseLooksLikeWorkProduct(role, displayContent);
  const isAssistantWorkProduct = isAssistantMarkdownWorkProduct || hasGeneratedFiles;
  const showInlineActions = showActions && !isAssistantWorkProduct;
  const imagePreviews = imagePreviewsForMessage({ images, attachments });
  const fileAttachments =
    hasGeneratedFiles && role === "assistant" ? [] : fileAttachmentsForMessage(attachments);
  const compactAttachments = shouldCompactAttachmentStack(role, fileAttachments);
  const visibleAttachments = visibleAttachmentsForMessage(role, fileAttachments, attachmentsExpanded);
  const hiddenAttachmentCount = fileAttachments.length - visibleAttachments.length;
  // Persistent identity for the two conversational roles (mono web view);
  // system / error stay as centered notices without an avatar. Suppressed for
  // the desktop gold work-product panel, which carries its own artifact header.
  const showIdentity = (role === "user" || role === "assistant") && !isAssistantWorkProduct;
  const identityName = isUser ? t("chat.identityUser") : t("chat.identityAssistant");

  return html`
    <div className=${messageOuterClass(isUser, isAssistantWorkProduct)} data-message-root="1" data-testid=${`msg-${role}`}>
      <div className=${messageShellClass(isUser, isAssistantWorkProduct)}>
        ${showIdentity &&
        html`
          <div
            className=${[
              "flex items-center gap-2 px-1",
              isUser ? "flex-row-reverse" : "",
            ].join(" ")}
          >
            <${Avatar} role=${role} />
            <span className="text-xs font-medium text-[var(--v2-text-muted)]">
              ${identityName}
            </span>
          </div>
        `}
        ${imagePreviews.length > 0 &&
        html`
          <div className=${imageThumbnailStripClass(isUser)} data-testid="message-image-thumbnails">
            ${imagePreviews.map(
              (preview, i) =>
                html`<img
                  key=${`${preview.src}-${i}`}
                  src=${preview.src}
                  className="h-24 max-w-[min(12rem,48vw)] rounded-[14px] border border-signal/25 bg-iron-950 object-cover shadow-[0_12px_32px_rgba(0,0,0,0.22)]"
                  alt=${preview.alt}
                  title=${preview.filename || preview.alt}
                  loading="lazy"
                />`
            )}
          </div>
        `}
        <div
          className=${messageBodyClass(role, isOptimistic, isAssistantWorkProduct)}
          data-testid=${isAssistantWorkProduct ? "assistant-work-product" : undefined}
        >
          ${isAssistantMarkdownWorkProduct &&
          html`<${GeneratedWorkProductHeader}
            title=${titleFromMarkdown(displayContent) || "Generated document"}
            content=${content || ""}
            messages=${messages}
            copied=${copied}
            onCopy=${copy}
          />`}
          ${hasGeneratedFiles &&
          html`<${GeneratedFileArtifactStack}
            artifacts=${generatedFileArtifacts}
            onPreview=${(artifact) =>
              setGeneratedFilePreview(generatedFilePreviewAttachment(artifact))}
          />`}
          ${role === "assistant" || role === "system" || role === "error"
            ? html`<${MarkdownRenderer} content=${displayContent} />`
            : html`<div className="whitespace-pre-wrap">${displayContent}</div>`}
          ${status === "error" &&
          html`
            <div
              className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--v2-danger-text)]"
            >
              <span>${error}</span>
            </div>
          `}
          ${fileAttachments.length > 0 &&
          html`
            <div
              className=${attachmentStackClass(compactAttachments)}
              data-testid=${compactAttachments ? "compact-attachment-stack" : "attachment-stack"}
            >
              ${compactAttachments &&
              html`
                <div className="flex flex-wrap items-center gap-2 px-1 pb-1 text-xs">
                  <span className="inline-flex items-center gap-1.5 font-medium text-iron-100">
                    <${Icon} name="file" className="h-3.5 w-3.5 text-signal" />
                    ${fileAttachments.length} files attached
                  </span>
                  <span className="text-iron-400">${attachmentStackSummary(fileAttachments)}</span>
                </div>
              `}
              ${visibleAttachments.map((att, i) => {
                const evidenceLabel = attachmentEvidenceLabel(att);
                return html`
                  <button
                    key=${i}
                    type="button"
                    onClick=${() => setAttachmentPreview(att)}
                    aria-label=${`Preview ${att.filename || "attachment"}`}
                    className="flex min-w-0 items-center gap-2 rounded-[10px] border border-iron-700 bg-iron-900/50 px-3 py-2 text-left text-xs hover:border-signal/40"
                  >
                    <${Icon} name="file" className="h-3.5 w-3.5 text-signal" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-iron-100"
                        >${att.filename || "attachment"}</span
                      >
                      <span className="block truncate text-[11px] text-iron-400"
                        >${evidenceLabel}</span
                      >
                    </span>
                    <span className="shrink-0 text-right text-[11px] text-iron-300">
                      <span className="block">${att.mime_type || "file"}</span>
                      ${att.size_label && html`<span className="block">${att.size_label}</span>`}
                    </span>
                    <span className="shrink-0 text-[11px] font-medium text-signal">Preview</span>
                    <${Icon} name="chevron" className="h-3 w-3 shrink-0 -rotate-90 text-iron-300" />
                  </button>
                `;
              })}
              ${compactAttachments &&
              hiddenAttachmentCount > 0 &&
              html`
                <button
                  type="button"
                  onClick=${() => setAttachmentsExpanded(true)}
                  className="v2-button mt-0.5 inline-flex w-full items-center justify-center gap-1 rounded-[10px] border border-signal/25 bg-signal/10 px-3 py-2 text-xs font-medium text-signal hover:bg-signal/15"
                  aria-label=${`Show ${hiddenAttachmentCount} more attached files`}
                  data-testid="attachment-stack-expand"
                >
                  Show ${hiddenAttachmentCount} more files
                  <${Icon} name="chevron" className="h-3 w-3 -rotate-90" />
                </button>
              `}
              ${compactAttachments &&
              attachmentsExpanded &&
              html`
                <button
                  type="button"
                  onClick=${() => setAttachmentsExpanded(false)}
                  className="v2-button mt-0.5 inline-flex w-full items-center justify-center gap-1 rounded-[10px] border border-iron-700 bg-transparent px-3 py-2 text-xs font-medium text-iron-300 hover:text-iron-100"
                  aria-label="Show fewer attached files"
                  data-testid="attachment-stack-collapse"
                >
                  Show fewer files
                  <${Icon} name="chevron" className="h-3 w-3 rotate-90" />
                </button>
              `}
            </div>
            <${AttachmentPreviewModal}
              open=${Boolean(attachmentPreview)}
              onClose=${() => setAttachmentPreview(null)}
              attachment=${attachmentPreview}
            />
          `}
          ${hasGeneratedFiles &&
          html`<${AttachmentPreviewModal}
            open=${Boolean(generatedFilePreview)}
            onClose=${() => setGeneratedFilePreview(null)}
            attachment=${generatedFilePreview}
          />`}
          ${desktopWorkProduct &&
          (role === "assistant" || role === "user") &&
          html`<${ProjectFileChips}
            threadId=${threadId}
            content=${typeof content === "string" ? content : ""}
          />`}
        </div>

        ${(showInlineActions || status === "error" || timeLabel) &&
        html`
          <div className=${messageActionRowClass(role, isUser)}>
            ${showInlineActions &&
            html`
              <button
                type="button"
                onClick=${copy}
                aria-label="Copy message"
                className="v2-button inline-flex items-center gap-1 rounded-md border-0 bg-transparent px-1.5 py-1 text-[11px] hover:text-iron-100"
              >
                <${Icon} name=${copied ? "check" : "copy"} className="h-3.5 w-3.5" />
                ${copied ? "Copied" : "Copy"}
              </button>
              ${desktopWorkProduct &&
              role === "assistant" &&
              html`<${AssistantExportActions} content=${content || ""} messages=${messages} />`}
            `}
            ${status === "error" &&
            onRetry &&
            html`
              <button
                type="button"
                onClick=${() => onRetry(message)}
                aria-label="Retry message"
                className="v2-button inline-flex items-center gap-1 rounded-md border-0 bg-transparent px-1.5 py-1 text-[11px] text-[var(--v2-danger-text)] hover:text-[var(--v2-danger-text)]"
              >
                <${Icon} name="retry" className="h-3.5 w-3.5" />
                Retry
              </button>
            `}
            ${timeLabel &&
            html`<span className="font-mono text-[10px] text-iron-400">${timeLabel}</span>`}
          </div>
        `}
      </div>
    </div>
  `;
}

function GeneratedWorkProductHeader({ title, content, messages, copied, onCopy }) {
  return html`
    <div
      className="mb-4 flex flex-wrap items-center gap-3 border-b border-[var(--v2-panel-border)] pb-3"
      data-testid="assistant-artifact-chip"
    >
      <span
        className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] border border-[color-mix(in_srgb,var(--v2-gold)_34%,var(--v2-panel-border))] bg-[var(--v2-gold-soft)] text-[var(--v2-gold-text)]"
        aria-hidden="true"
      >
        <${Icon} name="file" className="h-4 w-4" />
      </span>
      <span className="min-w-[12rem] flex-1">
        <span
          className="block text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--v2-gold-text)]"
        >
          Generated document
        </span>
        <span className="block truncate text-sm font-semibold text-[var(--v2-text-strong)]">
          ${title}
        </span>
        <span className="block text-xs leading-5 text-[var(--v2-text-muted)]">
          Markdown preview · exportable as DOCX, PDF, HTML, and JSON.
        </span>
      </span>
      <span className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick=${onCopy}
          aria-label="Copy generated document"
          className=${actionClass()}
        >
          <${Icon} name=${copied ? "check" : "copy"} className="h-3.5 w-3.5" />
          ${copied ? "Copied" : "Copy"}
        </button>
        <${AssistantExportActions}
          content=${content}
          messages=${messages}
          subjectLabel="generated document"
          popoverSide="bottom"
        />
      </span>
    </div>
  `;
}

function GeneratedFileArtifactStack({ artifacts, onPreview }) {
  if (!artifacts?.length) return null;
  return html`
    <div className="mb-3 grid gap-2" data-testid="generated-file-artifacts">
      ${artifacts.map(
        (artifact) =>
          html`<${GeneratedFileArtifactCard}
            key=${artifact.id || artifact.filename}
            artifact=${artifact}
            onPreview=${onPreview}
          />`
      )}
    </div>
  `;
}

function GeneratedFileArtifactCard({ artifact, onPreview }) {
  const [busy, setBusy] = React.useState("");
  const kind = generatedFileKindLabel(artifact);
  const filename = artifact.filename || artifact.title || "generated-output";
  const saveOriginal = async () => {
    setBusy("save");
    try {
      const blob = buildGeneratedFileBlob(artifact);
      if (!blob) {
        toast("File bytes unavailable", { tone: "error" });
        return;
      }
      const saved = await saveBlob(blob, filename);
      if (saved) toast(`Saved ${String(saved).split("/").pop()}`, { tone: "success" });
    } catch {
      toast("Could not save file", { tone: "error" });
    } finally {
      setBusy("");
    }
  };
  const saveToWorkProduct = () => {
    try {
      const saved = saveGeneratedFileArtifactToWork({ artifact });
      if (!saved) {
        toast("File bytes unavailable", { tone: "error" });
        return;
      }
      toast("Saved to Work", { tone: "success" });
      openSavedWorkProduct(saved);
    } catch {
      toast("Could not save work product", { tone: "error" });
    }
  };

  return html`
    <div
      className="flex min-w-0 flex-wrap items-center gap-3 rounded-[12px] border border-[color-mix(in_srgb,var(--v2-gold)_30%,var(--v2-panel-border))] bg-[var(--v2-gold-soft)] px-3 py-3 text-sm"
      data-testid="generated-file-artifact-chip"
    >
      <span
        className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] bg-[color-mix(in_srgb,var(--v2-gold)_18%,transparent)] text-[var(--v2-gold-text)]"
        aria-hidden="true"
      >
        <${Icon} name="file" className="h-4 w-4" />
      </span>
      <span className="min-w-[12rem] flex-1">
        <span
          className="block text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--v2-gold-text)]"
        >
          Generated file · ${kind}
        </span>
        <span className="block truncate text-sm font-semibold text-[var(--v2-text-strong)]">
          ${filename}
        </span>
        <span className="block truncate text-xs text-[var(--v2-text-muted)]">
          ${artifact.mime_type || "application/octet-stream"}
          ${artifact.size_label ? ` · ${artifact.size_label}` : ""}
        </span>
      </span>
      <span className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick=${() => onPreview?.(artifact)}
          className=${actionClass()}
          aria-label=${`Preview ${filename}`}
        >
          <${Icon} name="file" className="h-3.5 w-3.5" />
          Preview
        </button>
        <button
          type="button"
          onClick=${saveOriginal}
          disabled=${Boolean(busy)}
          className=${actionClass()}
          aria-label=${`Save ${filename}`}
        >
          <${Icon} name="download" className="h-3.5 w-3.5" />
          ${busy === "save" ? "Saving..." : "Save"}
        </button>
        <button
          type="button"
          onClick=${saveToWorkProduct}
          className=${actionClass("primary")}
          aria-label=${`Save ${filename} to Work`}
        >
          Save to Work
        </button>
      </span>
    </div>
  `;
}

function AssistantExportActions({
  content,
  messages,
  subjectLabel = "assistant response",
  popoverSide = "top",
}) {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const rootRef = React.useRef(null);
  const title = titleFromMarkdown(content) || "Assistant response";
  const subject = String(subjectLabel || "assistant response");

  // Embed rendered mermaid diagrams (the user clicked "Render diagram") as real
  // images in the DOCX and PDF; un-rendered diagrams keep the source-only
  // export. The same rasterized images feed both formats (DOCX uses the PNG,
  // PDF uses the JPEG variant) so screen and export stay in lockstep.
  const collectRenderedDiagramImages = async () => {
    const messageRoot = rootRef.current?.closest?.("[data-message-root]");
    return messageRoot ? await collectMermaidExportImages(messageRoot) : [];
  };
  const exportDocxWithDiagrams = async () => {
    const images = await collectRenderedDiagramImages();
    return downloadDocx(content, "assistant-response.docx", images.length ? { images } : undefined);
  };
  const exportPdfWithDiagrams = async () => {
    const images = await collectRenderedDiagramImages();
    return downloadPdf(content, "assistant-response.pdf", images.length ? { images } : undefined);
  };
  const exportOptions = [
    {
      id: "md",
      label: "Markdown",
      description: "Plain-text draft",
      action: async () => downloadMarkdown(content),
    },
    {
      id: "html",
      label: "HTML",
      description: "Browser-ready document",
      action: async () => downloadHtml(content),
    },
    {
      id: "pdf",
      label: "PDF",
      description: "Readable PDF",
      action: exportPdfWithDiagrams,
    },
    {
      id: "docx",
      label: "DOCX",
      description: "Word document",
      action: exportDocxWithDiagrams,
    },
    {
      id: "json",
      label: "JSON",
      description: "Structured response",
      action: async () => downloadJson({ role: "assistant", content }),
    },
    {
      id: "thread-md",
      label: "Thread MD",
      description: "Whole conversation",
      action: async () => exportThread("markdown", messages),
    },
    {
      id: "thread-docx",
      label: "Thread DOCX",
      description: "Whole conversation",
      action: async () => exportThread("docx", messages),
    },
    {
      id: "thread-pdf",
      label: "Thread PDF",
      description: "Whole conversation",
      action: async () => exportThread("pdf", messages),
    },
    {
      id: "thread-json",
      label: "Thread JSON",
      description: "Whole conversation data",
      action: async () => exportThread("json", messages),
    },
  ];

  const runExport = async (option) => {
    const saved = await option.action();
    if (saved) toast(`Saved ${String(saved).split("/").pop()}`, { tone: "success" });
    setMenuOpen(false);
  };

  return html`
    <span ref=${rootRef} className="contents">
      <button
        type="button"
        onClick=${() => saveResponseToWork(title, content, messages)}
        className=${actionClass("primary")}
        aria-label=${`Save ${subject} to Work`}
      >
        Save to Work
      </button>
      <${Popover}
        open=${menuOpen}
        onClose=${() => setMenuOpen(false)}
        align="start"
        side=${popoverSide}
        className="w-[min(22rem,calc(100vw-2rem))] max-w-none p-2"
        trigger=${html`
          <button
            type="button"
            onClick=${() => setMenuOpen((value) => !value)}
            className=${actionClass()}
            aria-label=${`Export ${subject}`}
            aria-expanded=${menuOpen ? "true" : "false"}
          >
            <${Icon} name="download" className="h-3.5 w-3.5" />
            Export
            <${Icon} name="chevron" className=${["h-3 w-3", menuOpen ? "rotate-180" : ""].join(" ")} />
          </button>
        `}
      >
        <div
          className="mb-1 px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-iron-400"
        >
          Download work product
        </div>
        <div className="grid gap-1">
          ${exportOptions.map(
            (option) => html`
              <button
                key=${option.id}
                type="button"
                onClick=${() => runExport(option)}
                className="flex w-full min-w-0 items-center gap-2 rounded-[8px] px-2 py-2 text-left text-sm text-iron-100 hover:bg-white/5"
              >
                <${Icon}
                  name=${option.id.includes("thread") ? "chat" : "file"}
                  className="h-4 w-4 shrink-0 text-signal"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">${option.label}</span>
                  <span className="block truncate text-xs text-iron-400"
                    >${option.description}</span
                  >
                </span>
                <${Icon} name="download" className="h-3.5 w-3.5 shrink-0 text-iron-400" />
              </button>
            `
          )}
        </div>
      <//>
    </span>
  `;
}

function messageActionRowClass(role, isUser) {
  const visibility =
    role === "assistant"
      ? "opacity-100"
      : "opacity-0 group-hover:opacity-100 focus-within:opacity-100";
  return [
    "flex max-w-full flex-wrap items-center gap-1.5 px-1 text-iron-400",
    visibility,
    isUser ? "justify-end" : "justify-start",
  ].join(" ");
}

function actionClass(tone = "default") {
  return [
    "v2-button inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px]",
    tone === "primary"
      ? "border border-signal/35 bg-signal/10 text-signal hover:bg-signal/15"
      : "border-0 bg-transparent hover:text-iron-100",
  ].join(" ");
}

function saveResponseToWork(title, content, messages = []) {
  try {
    const saved = saveAssistantResponseToWork({ title, content, messages });
    if (!saved) {
      toast("Nothing to save", { tone: "error" });
      return;
    }
    toast("Saved to Work", { tone: "success" });
    openSavedWorkProduct(saved);
  } catch {
    toast("Could not save work product", { tone: "error" });
  }
}

function exportThread(format, messages = []) {
  const title =
    typeof document === "undefined" ? "IronClaw chat" : document.title || "IronClaw chat";
  if (format === "json") {
    const content = buildThreadJsonExport(messages, { title });
    return exportContent("ironclaw-chat-thread.json", "application/json;charset=utf-8", content);
  }
  const markdown = buildThreadMarkdownExport(messages, { title });
  if (format === "docx") {
    return saveBlob(buildDocxBlob(markdown), "ironclaw-chat-thread.docx");
  }
  if (format === "pdf") {
    return saveBlob(buildPdfBlob(markdown), "ironclaw-chat-thread.pdf");
  }
  return exportContent("ironclaw-chat-thread.md", "text/markdown;charset=utf-8", markdown);
}

function exportContent(filename, type, content) {
  // Native save on desktop (anchor downloads are dead in WKWebView).
  return saveBlob(new Blob([content], { type }), filename);
}

function titleFromMarkdown(markdown) {
  const line = String(markdown || "")
    .split(/\r?\n/)
    .find((candidate) => candidate.trim());
  return (line || "Assistant response").replace(/^#+\s*/, "").trim();
}

// Memoized: during streaming the message list re-renders on every chunk, but
// only the streaming message's `message` reference changes. Bubbles whose
// `message`/`onRetry` props are unchanged skip re-rendering (and so skip
// re-parsing their markdown). Relies on unchanged messages keeping a stable
// object identity across `setMessages` updates, and on `onRetry` being a stable
// callback from the parent.
export const MessageBubble = React.memo(MessageBubbleImpl);
