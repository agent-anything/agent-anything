import type { HelarcDesktopApi } from "../shared/HelarcDesktopApi.js";

declare global {
  interface Window {
    helarc: HelarcDesktopApi;
  }
}

export {};
