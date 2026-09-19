/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        base: {
          bg: "#14171C",
          panel: "#1B1F26",
          panelRaised: "#232833",
          border: "#2C323D",
        },
        ink: {
          primary: "#E6E9EF",
          secondary: "#8B92A5",
          faint: "#565D6B",
        },
        signal: {
          active: "#5B8DEF", // routing / in-progress / primary accent
          stored: "#3FBF83", // complete / stored
          warn: "#E8A33D", // partial / degraded
          fail: "#E5626B", // failed / error
        },
      },
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "sans-serif",
        ],
        display: [
          "Space Grotesk",
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "sans-serif",
        ],
        mono: [
          "IBM Plex Mono",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "monospace",
        ],
      },
    },
  },
  plugins: [],
};
