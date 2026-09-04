import { useRef, useState } from "react";
import type { DocumentRecord } from "../../types";
import type { DocumentsController } from "../../hooks/useDocuments";

interface DocumentsViewProps {
  documents: DocumentsController;
}

// The "Documents" focus view (Documents v1A, Objectives 17-21) — a file
// picker/upload control, a document library list (filename/type/size/
// date/status/delete), and a simple metadata + text preview pane. Follows
// the same .focus-view / .focus-grid two-column layout MemoryView already
// established, so the HUD's visual language stays consistent without
// redesigning anything else.
export function DocumentsView({ documents }: DocumentsViewProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  // Counts nested enter/leave pairs rather than toggling on every one —
  // the drop target below has children (heading, button, list rows), and
  // the browser fires a dragleave for the parent + a dragenter for each
  // child as the pointer crosses between them, which would otherwise
  // flicker isDragOver off mid-drag. Only true 0 means "actually left the
  // whole zone."
  const dragDepthRef = useRef(0);

  function handleDragEnter(e: React.DragEvent) {
    e.preventDefault();
    dragDepthRef.current += 1;
    setIsDragOver(true);
  }

  function handleDragOver(e: React.DragEvent) {
    // Must ALSO be prevented here, on every dragover event — dragenter
    // alone only registers the element as a drop target for that instant;
    // without this, Safari and Firefox both fall back to their default
    // action for the drop (usually navigating to the dropped file) and
    // onDrop never fires. This was the actual bug: only dragover was
    // handled before, and by itself that's not reliably enough.
    e.preventDefault();
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDragOver(false);
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    dragDepthRef.current = 0;
    setIsDragOver(false);
    handleFiles(e.dataTransfer.files);
  }

  async function handleFiles(fileList: FileList | null) {
    const file = fileList?.[0];
    if (!file) return;

    setUploading(true);
    setUploadError(null);

    const result = await documents.uploadDocument(file);

    if (!result.success) {
      setUploadError(result.error ?? "Failed to upload this document.");
    }

    setUploading(false);

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  function handleDelete(record: DocumentRecord) {
    if (!window.confirm(`Delete "${record.displayName}"?`)) return;
    documents.deleteDocument(record.id);
  }

  return (
    <div className="focus-view">
      <h2>Document Library</h2>

      <div className="focus-grid">
        {/* Drag-and-drop targets the WHOLE column (heading, upload row, and
            list), not just the slim upload row — a single-line target was
            too small to reliably hit. dragenter/dragover/dragleave/drop are
            all handled here in one place (see the drag-depth counter above)
            so hovering over any child (button, list row) doesn't flicker
            the highlight off mid-drag. */}
        <div
          className={isDragOver ? "document-column drag-over" : "document-column"}
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <h3>
            Documents{documents.documents.length > 0 ? ` (${documents.documents.length})` : ""}
          </h3>

          {/* The primary, guaranteed-to-work way to add a file: a real
              file-picker button (opens the OS's native file dialog —
              Finder on macOS) via a <label>/<input type="file"> pair. This
              is the main path, not a fallback — drag-and-drop is still
              wired up on the column below as a bonus for browsers where it
              behaves, but it isn't reliable enough across every setup to
              be the thing users are told to rely on. */}
          <label className="document-upload-button">
            {uploading ? "Processing..." : "Choose File..."}
            <input
              ref={fileInputRef}
              type="file"
              className="document-file-input"
              accept=".txt,.md,.markdown,.json,.csv,.pdf,.docx,.ts,.tsx,.js,.jsx,.py,.java,.cs,.go,.rs,.html,.css,.yaml,.yml"
              onChange={(e) => handleFiles(e.target.files)}
              disabled={uploading}
            />
          </label>

          {uploadError && <p className="document-upload-error">{uploadError}</p>}

          <ul className="documents-list">
            {documents.loading ? (
              <li className="document-empty">Loading...</li>
            ) : documents.error ? (
              <li className="document-empty">{documents.error}</li>
            ) : documents.documents.length === 0 ? (
              <li className="document-empty">No documents yet</li>
            ) : (
              documents.documents.map((record) => (
                <DocumentRow
                  key={record.id}
                  record={record}
                  isSelected={documents.selectedDocument?.id === record.id}
                  onSelect={() => documents.selectDocument(record.id)}
                  onDelete={() => handleDelete(record)}
                />
              ))
            )}
          </ul>
        </div>

        <div>
          <h3>Preview</h3>
          <DocumentPreview documents={documents} />
        </div>
      </div>
    </div>
  );
}

interface DocumentRowProps {
  record: DocumentRecord;
  isSelected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}

function DocumentRow({ record, isSelected, onSelect, onDelete }: DocumentRowProps) {
  return (
    <li className={`document-row ${isSelected ? "selected" : ""}`}>
      <button type="button" className="document-row-main" onClick={onSelect}>
        <p className="document-name">{record.displayName}</p>
        <div className="document-meta">
          <span className="document-type-badge">{record.fileType}</span>
          <span>{formatBytes(record.sizeBytes)}</span>
          <span>{formatDate(record.createdAt)}</span>
          <DocumentStatusBadge status={record.status} />
        </div>
      </button>

      <button type="button" className="document-delete-button" onClick={onDelete} title="Delete">
        ×
      </button>
    </li>
  );
}

function DocumentStatusBadge({ status }: { status: DocumentRecord["status"] }) {
  const label = status === "ready" ? "Ready" : status === "processing" ? "Processing..." : "Error";
  return <span className={`document-status document-status--${status}`}>{label}</span>;
}

function DocumentPreview({ documents }: { documents: DocumentsController }) {
  const record = documents.selectedDocument;

  if (!record) {
    return <p className="document-empty">Select a document to preview it.</p>;
  }

  return (
    <div className="document-preview">
      <div className="document-preview-meta">
        <p>
          <strong>{record.displayName}</strong>
        </p>
        <p>Original filename: {record.originalName}</p>
        <p>
          Type: {record.fileType} &middot; Size: {formatBytes(record.sizeBytes)}
        </p>
        <p>Uploaded: {formatDate(record.createdAt)}</p>
        <p>
          Status: <DocumentStatusBadge status={record.status} />
        </p>
      </div>

      <div className="document-preview-text">
        {documents.contentLoading ? (
          <p className="document-empty">Loading content...</p>
        ) : documents.documentContent !== null ? (
          <pre>{documents.documentContent}</pre>
        ) : (
          <p className="document-empty">{documents.contentMessage ?? "No extracted content is available."}</p>
        )}
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}
