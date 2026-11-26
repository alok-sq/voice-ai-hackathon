import type { Language } from "../sources/types";

export const LANGUAGES: { value: Language; label: string }[] = [
  { value: "hi", label: "Hindi" },
  { value: "mr", label: "Marathi" },
  { value: "ta", label: "Tamil" },
  { value: "kn", label: "Kannada" },
  { value: "en", label: "English" },
];

export const languageLabel = (l: Language) => LANGUAGES.find((x) => x.value === l)?.label ?? l;
