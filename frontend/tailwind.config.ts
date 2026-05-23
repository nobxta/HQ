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
        "fade-in": "fadeIn 0.5s cubic-bezier(0.16, 1, 0.3, 1)",
        "fade-in-up": "fadeInUp 0.6s cubic-bezier(0.16, 1, 0.3, 1)",
        "slide-up": "slideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1)",
        "slide-down": "slideDown 0.4s cubic-bezier(0.16, 1, 0.3, 1)",
        "scale-in": "scaleIn 0.4s cubic-bezier(0.16, 1, 0.3, 1)",
        "count-up": "fadeIn 0.6s ease-out",
        "shimmer": "shimmer 2s linear infinite",
        "float": "float 6s ease-in-out infinite",
        "glow": "glow 2s ease-in-out infinite alternate",
        "spin-slow": "spin 3s linear infinite",
        "bounce-subtle": "bounceSubtle 2s ease-in-out infinite",
        "width-grow": "widthGrow 1s cubic-bezier(0.16, 1, 0.3, 1)",
        "number-tick": "numberTick 0.8s cubic-bezier(0.16, 1, 0.3, 1)",
        "stagger-1": "fadeInUp 0.5s cubic-bezier(0.16, 1, 0.3, 1) 0.05s both",
        "stagger-2": "fadeInUp 0.5s cubic-bezier(0.16, 1, 0.3, 1) 0.1s both",
        "stagger-3": "fadeInUp 0.5s cubic-bezier(0.16, 1, 0.3, 1) 0.15s both",
        "stagger-4": "fadeInUp 0.5s cubic-bezier(0.16, 1, 0.3, 1) 0.2s both",
      },
      keyframes: {
        fadeIn: { "0%": { opacity: "0" }, "100%": { opacity: "1" } },
        fadeInUp: {
          "0%": { opacity: "0", transform: "translateY(16px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        slideUp: {
          "0%": { opacity: "0", transform: "translateY(10px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        slideDown: {
          "0%": { opacity: "0", transform: "translateY(-10px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        scaleIn: {
          "0%": { opacity: "0", transform: "scale(0.95)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        float: {
          "0%, 100%": { transform: "translateY(0px)" },
          "50%": { transform: "translateY(-6px)" },
        },
        glow: {
          "0%": { boxShadow: "0 0 5px rgba(108, 92, 231, 0.2)" },
          "100%": { boxShadow: "0 0 20px rgba(108, 92, 231, 0.4)" },
        },
        bounceSubtle: {
          "0%, 100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-3px)" },
        },
        widthGrow: {
          "0%": { width: "0%" },
          "100%": { width: "var(--target-width)" },
        },
        numberTick: {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
      backdropBlur: {
        xs: "2px",
      },
      boxShadow: {
        "glass": "0 4px 30px rgba(0, 0, 0, 0.1)",
        "glass-lg": "0 8px 32px rgba(0, 0, 0, 0.15)",
        "glow-accent": "0 0 20px rgba(108, 92, 231, 0.15)",
        "glow-success": "0 0 20px rgba(0, 206, 201, 0.15)",
        "glow-danger": "0 0 20px rgba(255, 107, 107, 0.15)",
        "inner-glow": "inset 0 1px 0 rgba(255, 255, 255, 0.05)",
      },
    },
  },
  plugins: [],
};
export default config;
