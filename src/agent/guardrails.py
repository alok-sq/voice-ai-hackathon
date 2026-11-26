"""Ground rules as code: recording notice, stop requests, no price/savings/subsidy claims."""
from __future__ import annotations

import re

# Spoken first. Recording notice, per the brief. (Hindi, Devanagari for clean TTS.)
DISCLOSURE_BY_LANG = {
    "hi": "नमस्ते! यह सोलरस्क्वेयर की तरफ़ से कॉल है। यह कॉल क्वालिटी के लिए रिकॉर्ड की जा रही है।",
    "en": "Hello! This is a call from SolarSquare. This call is being recorded for quality purposes.",
}
DISCLOSURE = DISCLOSURE_BY_LANG["hi"]

GREETING_QUESTION = {
    "hi": "क्या आपने हाल ही में रूफटॉप सोलर के बारे में पूछताछ की थी?",
    "en": "Did you recently enquire about rooftop solar?",
}


def greeting(language: str) -> str:
    """Recording notice first, then the identity question. Other languages fall back to Hindi for now."""
    lang = language if language in DISCLOSURE_BY_LANG else "hi"
    return f"{DISCLOSURE_BY_LANG[lang]} {GREETING_QUESTION[lang]}"

CLOSING_DNC = "ठीक है, माफ़ कीजिए परेशानी के लिए। हम दोबारा कॉल नहीं करेंगे। धन्यवाद।"

_STOP_PATTERNS = [
    r"do not call", r"don'?t call", r"stop calling", r"stop (the )?call", r"remove (my )?number",
    r"call (mat|na) kar", r"mat call", r"call mat", r"phone mat", r"fone mat", r"dobara (call|phone) mat",
    r"band kar", r"bandh kar", r"pareshan mat", r"number (hata|delete|remove)",
    r"कॉल मत", r"फोन मत", r"फ़ोन मत", r"कॉल न करें", r"कॉल ना करें", r"बंद कर", r"परेशान मत", r"नंबर हटा",
]
_STOP_RE = re.compile("|".join(_STOP_PATTERNS), re.IGNORECASE)


def is_stop_request(text: str) -> bool:
    return bool(_STOP_RE.search(text or ""))


# Topic words: a price, saving or subsidy being discussed.
_TOPIC_RE = re.compile(
    r"subsid|sabsid|सब्सिडी|सब्सिडि|saving|bachat|bachega|बचत|बचेगा|bachayeg|"
    r"price|pricing|keemat|kimat|कीमत|क़ीमत|daam|दाम|cost|laagat|लागत|kharcha|खर्च|"
    r"emi|payback|discount|छूट|chhoot",
    re.IGNORECASE,
)
# A figure: digits, currency, or Hindi number words (including the Devanagari "sau" that is not part of "saur").
_FIGURE_RE = re.compile(
    r"\d|₹|\brs\b|\brupee|\brupay|रुपय|रुपए|रूपय|"
    r"\bhazaar\b|\bhazar\b|\blakh\b|\bcrore\b|हज़ार|हजार|लाख|करोड़|सौ(?![\u0900-\u097F])|\bsau\b|"
    r"\bpercent\b|%|प्रतिशत|\bdhai\b|ढाई",
    re.IGNORECASE,
)


def contains_forbidden_claim(text: str) -> bool:
    """True for agent text stating a price, savings or subsidy figure.

    Strict on purpose: a false positive costs one deflection, a false negative breaks a ground rule.
    """
    if not text:
        return False
    return bool(_TOPIC_RE.search(text) and _FIGURE_RE.search(text))


def claim_kind(text: str) -> str:
    t = text.lower()
    if re.search(r"subsid|sabsid|सब्सिडी", t):
        return "subsidy"
    if re.search(r"saving|bachat|bachega|बचत|बचेगा", t):
        return "savings"
    if re.search(r"price|keemat|kimat|कीमत|daam|दाम|cost|लागत|कीमत", t):
        return "price"
    return "other"


def safe_deflection() -> str:
    return "इसकी सही जानकारी हमारे सोलर एक्सपर्ट मीटिंग में देंगे।"
