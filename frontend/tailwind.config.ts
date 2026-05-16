import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        sans: ["'Space Grotesk'", "system-ui", "sans-serif"],
        mono: ["'JetBrains Mono'", "monospace"],
      },
      colors: {
        dark: {
          50: "#f7f7f8",
          100: "#ececf1",
          200: "#d9d9e3",
          300: "#c5c5d2",
          400: "#acacbe",
          500: "#8e8ea0",
          600: "#6e6e80",
          700: "#4a4a5a",
          800: "#2d2d3a",
          850: "#252533",
          900: "#1a1a2e",
          950: "#0f0f1a",
        },
        accent: {
          DEFAULT: "#6c5ce7",
          50: "#f0eeff",
          100: "#e0dcff",
          200: "#c4b8ff",
          300: "#a48bff",
          400: "#8b6cff",
          500: "#6c5ce7",
          600: "#5a45d6",
          700: "#4a35b5",
          800: "#3d2b94",
          900: "#312273",
        },
        success: { DEFAULT: "#00cec9", dark: "#009e9a" },
        warning: { DEFAULT: "#fdcb6e", dark: "#e5a900" },
        danger: { DEFAULT: "#ff6b6b", dark: "#d63031" },
        info: { DEFAULT: "#74b9ff", dark: "#0984e3" },
      },
      animation: {
        "pulse-slow": "pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "fade-in": "fadeIn 0.3s ease-out",
        "slide-up": "slideUp 0.3s ease-out",
      },
      keyframes: {
        fadeIn: { "0%": { opacity: "0" }, "100%": { opacity: "1" } },
        slideUp: {
          "0%": { opacity: "0", transform: "translateY(10px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
    },
  },
  plugins: [],
};
export default config;
