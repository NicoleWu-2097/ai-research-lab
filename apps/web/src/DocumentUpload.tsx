import { useState } from "react";
export function DocumentUpload({
  disabled,
  onUploaded,
}: {
  disabled?: boolean;
  onUploaded: (name: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  return (
    <div className="upload-control">
      <label>
        上传 RAG 文档（MD / TXT，24 KB）
        <input
          type="file"
          accept=".md,.txt"
          disabled={disabled || busy}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            e.target.value = "";
            if (file.size > 24000) {
              setMessage("文件不能超过 24 KB");
              return;
            }
            setBusy(true);
            setMessage("正在上传并建立索引…");
            try {
              const data = new FormData();
              data.append("file", file);
              const response = await fetch("/api/rag/upload", {
                method: "POST",
                body: data,
              });
              const body = await response.json();
              if (!response.ok) throw new Error(body.error ?? "上传失败");
              onUploaded(body.name);
              setMessage(`${body.name} 已索引 · ${body.chunks} 个片段`);
            } catch (error) {
              setMessage(error instanceof Error ? error.message : "上传失败");
            } finally {
              setBusy(false);
            }
          }}
        />
      </label>
      <small role="status">{message}</small>
      <small>加入本机共享知识库；后续研究可检索使用。</small>
    </div>
  );
}
