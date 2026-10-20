import { createRoot } from "react-dom/client";
import App from "./App";
// Native packages contain their UI. No Service Worker and no Python/API fallback.
createRoot(document.getElementById("root")!).render(<App />);
