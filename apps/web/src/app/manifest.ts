import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Dayline",
    short_name: "Dayline",
    description: "Dayline Mailboxen, Kalender, Aufgaben und Notizen uneinheitlich verwalten",
    start_url: "/today",
    display: "standalone",
    background_color: "#f5f7f8",
    theme_color: "#5f95d8",
    lang: "de-DE",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "maskable",
      },
    ],
  };
}
