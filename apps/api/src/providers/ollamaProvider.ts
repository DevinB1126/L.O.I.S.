import axios from "axios";

type OllamaResponse = {
  response: string;
};

export async function askOllama(prompt: string): Promise<string> {
  const response = await axios.post<OllamaResponse>(
    "http://localhost:11434/api/generate",
    {
      model: "llama3.1",
      prompt,
      stream: false
    }
  );

  return response.data.response;
}
export async function streamOllamaResponse(
  prompt: string,
  onChunk: (chunk: string) => void
): Promise<string> {
  const response = await fetch("http://localhost:11434/api/generate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "llama3.1",
      prompt,
      stream: true,
    }),
  });

  if (!response.body) {
    throw new Error("No response body from Ollama");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let fullReply = "";

  while (true) {
    const { done, value } = await reader.read();

    if (done) break;

    const chunk = decoder.decode(value);
    const lines = chunk.split("\n").filter(Boolean);

    for (const line of lines) {
      const parsed = JSON.parse(line);

      if (parsed.response) {
        fullReply += parsed.response;
        onChunk(parsed.response);
      }
    }
  }

  return fullReply;
}