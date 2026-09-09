import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { ConfigProvider } from "antd";
import { App } from "./App.js";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<ConfigProvider theme={{ token: { colorPrimary: "#176858", borderRadius: 4, fontSize: 13, colorBgLayout: "#f3f5f6" } }}><BrowserRouter><App /></BrowserRouter></ConfigProvider>);
