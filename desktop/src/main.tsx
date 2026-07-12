import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { UpdateProvider } from "./contexts/UpdateContext";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 3000, // E-P1-8: 3s 内复用缓存，避免 5s 轮询强制重新 fetch
    },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <UpdateProvider>
        <App />
      </UpdateProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
