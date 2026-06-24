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