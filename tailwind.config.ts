import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        paper: "#EEF2F6",
        panel: "#FFFFFF",
        rule: "#D5DCE5",
        ink: {
          DEFAULT: "#13233F",
          soft: "#45526A",
          faint: "#7A869B",
        },
        settled: { DEFAULT: "#0E7C6B", soft: "#D3EDE8" },
        reserved: { DEFAULT: "#D99A1E", soft: "#F8EBCD" },
        signal: { DEFAULT: "#C2352B", soft: "#F7DCD9" },
      },
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
      },
      borderRadius: {
        meter: "3px",
      },
      keyframes: {
        "meter-fill": {
          from: { transform: "scaleX(0)" },
          to: { transform: "scaleX(1)" },
        },
      },
      animation: {
        "meter-fill": "meter-fill 900ms cubic-bezier(0.22, 1, 0.36, 1) both",
      },
    },
  },
  plugins: [],
};

export default config;
