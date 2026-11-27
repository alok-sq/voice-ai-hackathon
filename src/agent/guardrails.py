"""Ground rules as code: recording notice, stop requests, no price/savings/subsidy claims."""
from __future__ import annotations

import re

# Spoken first. Recording notice, per the brief. (Hindi, Devanagari for clean TTS.)
DISCLOSURE_BY_LANG = {
    "hi": "नमस्ते! मैं अजय बोल रहा हूँ, सोलरस्क्वेयर से। यह कॉल क्वालिटी के लिए रिकॉर्ड की जा रही है।",
    "en": "Hello! This is Ajay from SolarSquare. This call is being recorded for quality purposes.",
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

GOODBYE = {
    "hi": "धन्यवाद आपका समय देने के लिए। अलविदा, आपका दिन shubh रहे।",
    "en": "Thank you for your time. Goodbye, and have a good day.",
}
CLOSING_DNC = {
    "hi": "ठीक है, माफ़ कीजिए परेशानी के लिए। हम दोबारा कॉल नहीं करेंगे। अलविदा, आपका दिन shubh रहे।",
    "en": "Alright, sorry for the trouble. We will not call again. Goodbye, and have a good day.",
}
SUGGEST_SOLAR = {
    "hi": "कोई बात नहीं। बहुत से लोग सिर्फ यह देखते हैं कि छत सही है या नहीं, और लगवाने की कोई मजबूरी नहीं होती। क्या आप थोड़ा और सुनना चाहेंगे?",
    "en": "That's alright. A lot of people only check whether the roof is suitable, and you are not committing to install anything. Would you like to hear a little more?",
}
SUGGEST_VISIT = {
    "hi": "कोई बात नहीं। किसी और दिन भी हो सकता है, वो भी फ्री, और आप तब भी मना कर सकते हैं। क्या कोई और दिन ठीक रहेगा?",
    "en": "That's alright. It can be another day, still free, and you can still say no. Would another day work?",
}
VISIT_OFFER = {
    "hi": "एक फ्री साइट विज़िट बुक कर दूँ? लगवाने की कोई मजबूरी नहीं होती।",
    "en": "Shall I book a free site visit? You would not be committing to install anything.",
}
VISIT_DAY = {
    "hi": "कौन सा दिन ठीक रहेगा?",
    "en": "Which day works?",
}
VISIT_TIME = {
    "hi": "टाइम क्या रहेगा, सुबह या शाम, कितने बजे?",
    "en": "What time works, morning or evening, and around what hour?",
}
HOSTILE_ONCE = {
    "hi": "मैं बात को सम्मान से रखना चाहूँगा। क्या हम सोलर के बारे में आगे बढ़ें?",
    "en": "I would like to keep this respectful. Shall we continue about solar?",
}
SENSITIVE = {
    "hi": "कार्ड नंबर, बैंक डिटेल, पासवर्ड या सरकारी आईडी मुझे नहीं चाहिए। हम अगली बात पर चलते हैं।",
    "en": "I don't need a card number, bank details, a password, or a government ID. Let's move on.",
}


def _line(table: dict[str, str], language: str) -> str:
    return table.get(language if language in table else "hi", table["hi"])


def goodbye(language: str) -> str:
    return _line(GOODBYE, language)


def closing_dnc(language: str) -> str:
    return _line(CLOSING_DNC, language)

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


_HOSTILE_RE = re.compile(
    r"\b(idiot|stupid|shut up|bloody|nonsense|bastard|faltu|bewakoof|bakwas|chutiya)\b|"
    r"चुप रह|बेवकूफ|बकवास|फालतू",
    re.IGNORECASE,
)
_SENSITIVE_RE = re.compile(
    r"(?:\d[ -]?){12,}|\b(password|aadhaar|aadhar|pan card|cvv|account number|otp)\b|"
    r"पासवर्ड|आधार|पैन कार्ड",
    re.IGNORECASE,
)
_TIME_RE = re.compile(
    r"baje|बजे|subah|shaam|sham|dopahar|सुबह|शाम|दोपहर|morning|evening|afternoon|\bam\b|\bpm\b",
    re.IGNORECASE,
)


def is_hostile(text: str) -> bool:
    return bool(_HOSTILE_RE.search(text or ""))


def is_sensitive(text: str) -> bool:
    return bool(_SENSITIVE_RE.search(text or ""))


def plan_special_turn(
    language: str,
    pending: str | None,
    text: str,
    *,
    interest_nudged: bool,
    visit_nudged: bool,
    visit_accepted: bool,
    meeting_day: str,
    hostile_warned: bool,
    side_question: bool,
) -> dict | None:
    """A scripted reply for the rules the model must not skip. None means save the answer normally."""
    if is_stop_request(text):
        return {"speak": closing_dnc(language), "end": "do_not_call", "reason": "caller asked to stop"}
    if is_sensitive(text):
        return {"speak": _line(SENSITIVE, language), "defer": True}
    if is_hostile(text):
        if hostile_warned:
            return {"speak": goodbye(language), "end": "callback", "reason": "caller stayed hostile"}
        return {"speak": _line(HOSTILE_ONCE, language), "set": {"hostile_warned": True}}
    if side_question:
        return None

    from . import normalise as nz

    answer = nz.parse_yes_no(text)
    if pending == "solar_interest" and answer is False:
        if not interest_nudged:
            return {"speak": _line(SUGGEST_SOLAR, language), "set": {"interest_nudged": True}}
        return {
            "speak": goodbye(language),
            "save": ("solar_interest", "nahi"),
            "end": "not_qualified",
            "reason": "declined after one suggestion",
        }
    if pending != "meeting_slot":
        return None
    if not visit_accepted:
        if answer is False:
            if not visit_nudged:
                return {"speak": _line(SUGGEST_VISIT, language), "set": {"visit_nudged": True}}
            return {"speak": goodbye(language), "end": "callback", "reason": "declined the visit"}
        if answer is True:
            return {"speak": _line(VISIT_DAY, language), "set": {"visit_accepted": True}}
        if text.strip() and _TIME_RE.search(text):
            return {"save": ("meeting_slot", text.strip()), "set": {"visit_accepted": True}}
        if text.strip():
            return {"speak": _line(VISIT_TIME, language), "set": {"visit_accepted": True, "meeting_day": text.strip()}}
        return None
    if not meeting_day:
        if text.strip() and _TIME_RE.search(text):
            return {"save": ("meeting_slot", text.strip())}
        if text.strip() and answer is None:
            return {"speak": _line(VISIT_TIME, language), "set": {"meeting_day": text.strip()}}
        return None
    if answer is False:
        return {"save": ("meeting_slot", meeting_day)}
    if text.strip():
        return {"save": ("meeting_slot", f"{meeting_day}, {text.strip()}")}
    return None
