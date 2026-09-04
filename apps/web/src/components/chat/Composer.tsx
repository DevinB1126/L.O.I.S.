import { useRef, useState } from "react";
import type { ChatController } from "../../hooks/useChat";
import type { VoiceController } from "../../hooks/useVoice";
import * as api from "../../services/api";

interface ComposerProps {
  chat: ChatController;
  voice: VoiceController;
  currentAgentLabel: string;
  onMicClick: () => void;
  /** Scopes the Attach control's upload to a project when present (see
   *  ProjectChatView) — omitted for the global chat, which uploads to
   *  Documents unscoped, same as the existing Documents view's default. */
  projectId?: string;
}

const MIN_TEXTAREA_HEIGHT = 52;
const MAX_TEXTAREA_HEIGHT = 240;

// Chat workspace pass (Objective B5) — replaces the old single-line
// CommandRow with a substantially larger composer: a textarea that starts
// at a comfortable height and grows with content up to a max before
// scrolling internally, plus Attach/Voice/Send controls. Still the one
// shared component both the global Chat view and any project chat use
// (Objective B17) — CommandRow's Enter-to-send / Shift+Enter-for-newline
// behavior is preserved exactly, just given more room to work in.
export function Composer({ chat, voice, currentAgentLabel, onMicClick, projectId }: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [attachStatus, setAttachStatus] = useState<string | null>(null);
  const [attaching, setAttaching] = useState(false);

  function autoGrow(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }

  function handleSend() {
    chat.sendMessage();
    // Reset height back to the comfortable minimum after sending — the
    // textarea's own value clears via chat.setMessage(""), but the
    // browser doesn't shrink a manually-set inline height on its own.
    requestAnimationFrame(() => {
      if (textareaRef.current) textareaRef.current.style.height = `${MIN_TEXTAREA_HEIGHT}px`;
    });
  }

  async function handleAttach(fileList: FileList | null) {
    const file = fileList?.[0];
    if (!file) return;

    setAttaching(true);
    setAttachStatus(null);

    const result = await api.uploadDocument(file, projectId);

    setAttaching(false);
    setAttachStatus(
      result.success
        ? `Attached "${file.name}" to Documents${projectId ? " for this project" : ""}.`
        : result.error ?? "Failed to attach this file."
    );

    if (fileInputRef.current) fileInputRef.current.value = "";

    // Transient — doesn't permanently occupy composer space.
    setTimeout(() => setAttachStatus(null), 5000);
  }

  return (
    <div className="composer">
      <div className="composer-box">
        <textarea
          ref={textareaRef}
          className="composer-textarea"
          value={chat.message}
          onChange={(e) => {
            chat.setMessage(e.target.value);
            autoGrow(e.target);
          }}
          placeholder={`Ask ${currentAgentLabel}...`}
          rows={1}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
        />

        <div className="composer-toolbar">
          <div className="composer-toolbar-left">
            <label className="composer-attach-button" title="Attach a file to Documents">
              {attaching ? "Attaching..." : "+ Attach"}
              <input
                ref={fileInputRef}
                type="file"
                className="document-file-input"
                onChange={(e) => handleAttach(e.target.files)}
                disabled={attaching}
              />
            </label>

            <button
              type="button"
              className={`composer-mic-button ${voice.voiceState}`}
              onClick={onMicClick}
              title={voice.voiceState === "speaking" ? "Stop speaking" : "Voice input"}
            >
              {voice.voiceState === "speaking" ? "■" : "🎙"}
            </button>

            {attachStatus && <span className="composer-attach-status">{attachStatus}</span>}
          </div>

          <button type="button" className="composer-send-button" onClick={handleSend} disabled={chat.isLoading}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
