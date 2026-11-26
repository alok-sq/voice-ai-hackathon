/** Matches the backend's check after stripping spaces, brackets and dashes. */
const PHONE_RE = /^\+?[0-9]{10,15}$/;

export const PHONE_ERROR = "Enter a 10 to 15 digit number, with the country code.";

export const normalisePhone = (p: string) => p.replace(/[\s()-]/g, "");

export const isValidPhone = (p: string) => PHONE_RE.test(normalisePhone(p));

/** Shows enough to recognise the number on screen without displaying all of it. */
export const maskPhone = (p: string) => {
  const d = normalisePhone(p);
  return d.length < 6 ? p : `${d.slice(0, 5)}•••${d.slice(-3)}`;
};
