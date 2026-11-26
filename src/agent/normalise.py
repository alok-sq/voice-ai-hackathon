"""Hinglish and Devanagari parsers. Rule based: deterministic and instant, no LLM calls.

Extend the tables as real call recordings are reviewed.
"""
from __future__ import annotations

import re
from typing import Optional

from .models import PropertyType, RoofOwnership

# ---------- numbers ----------

_UNITS = {
    # romanised
    "ek": 1, "do": 2, "teen": 3, "tin": 3, "char": 4, "chaar": 4, "paanch": 5, "panch": 5, "pach": 5,
    "chhe": 6, "chhah": 6, "che": 6, "chah": 6, "saat": 7, "sat": 7, "aath": 8, "ath": 8, "nau": 9,
    "das": 10, "dus": 10, "gyarah": 11, "barah": 12, "terah": 13, "chaudah": 14, "pandrah": 15,
    "solah": 16, "satrah": 17, "atharah": 18, "unnis": 19, "bees": 20, "pachchis": 25, "pachis": 25,
    "tees": 30, "tis": 30, "chalis": 40, "pachas": 50, "saath": 60, "sattar": 70, "assi": 80, "nabbe": 90,
    # devanagari
    "एक": 1, "दो": 2, "तीन": 3, "चार": 4, "पांच": 5, "पाँच": 5, "छह": 6, "छः": 6, "छे": 6, "सात": 7,
    "आठ": 8, "नौ": 9, "दस": 10, "ग्यारह": 11, "बारह": 12, "तेरह": 13, "चौदह": 14, "पंद्रह": 15,
    "सोलह": 16, "सत्रह": 17, "अठारह": 18, "उन्नीस": 19, "बीस": 20, "पच्चीस": 25, "तीस": 30,
    "चालीस": 40, "पचास": 50, "साठ": 60, "सत्तर": 70, "अस्सी": 80, "नब्बे": 90,
    # fractions people say for bills
    "dhai": 2.5, "dhaai": 2.5, "ढाई": 2.5, "derh": 1.5, "dedh": 1.5, "डेढ़": 1.5, "डेढ": 1.5,
}
_MULT = {
    "sau": 100, "सौ": 100,
    "hazaar": 1000, "hazar": 1000, "hajar": 1000, "hajaar": 1000, "हज़ार": 1000, "हजार": 1000,
    "lakh": 100000, "lac": 100000, "लाख": 100000,
}
_DEVANAGARI_DIGITS = str.maketrans("०१२३४५६७८९", "0123456789")
_TOKEN_RE = re.compile(r"\d[\d,]*\.?\d*|[a-z]+|[\u0900-\u097F]+")


def parse_amount(text: str) -> Optional[int]:
    """'3 hazaar' -> 3000, 'paanch sau' -> 500, 'dhai hazaar' -> 2500, '3,500 rupaye' -> 3500."""
    text = text.lower().translate(_DEVANAGARI_DIGITS)
    total = 0.0
    pending: Optional[float] = None
    found = False
    for tok in _TOKEN_RE.findall(text):
        if tok[0].isdigit():
            try:
                pending = float(tok.replace(",", ""))
            except ValueError:
                continue
            found = True
        elif tok in _UNITS:
            pending = float(_UNITS[tok])
            found = True
        elif tok in _MULT:
            total += (pending if pending is not None else 1.0) * _MULT[tok]
            pending = None
            found = True
    if pending is not None:
        total += pending
    return int(round(total)) if found else None


# ---------- yes / no ----------

_YES = {"haan", "han", "haa", "haanji", "yes", "yeah", "yep", "bilkul", "zaroor", "sahi", "theek", "thik", "ok",
        "okay", "correct", "right", "हाँ", "हां", "जी", "हाँजी", "बिल्कुल", "ज़रूर", "जरूर", "सही", "ठीक"}
_NO = {"nahi", "nahin", "nhi", "na", "no", "nope", "mat", "नहीं", "नही", "ना", "मत"}
_WEAK_YES = {"ji", "जी"}


def parse_yes_no(text: str) -> Optional[bool]:
    tokens = set(re.findall(r"[a-z]+|[\u0900-\u097F]+", text.lower()))
    yes = tokens & (_YES - _WEAK_YES)
    no = tokens & _NO
    if yes and no:
        return None
    if no:
        return False
    if yes:
        return True
    if tokens & _WEAK_YES:
        return True
    return None


# ---------- property type / roof ownership ----------

def _has(text: str, words) -> bool:
    return any(w in text for w in words)


def parse_property_type(text: str) -> Optional[PropertyType]:
    t = text.lower()
    if _has(t, ["society", "apartment", "flat", "housing", "सोसाइटी", "सोसायटी", "फ्लैट", "अपार्टमेंट"]):
        return PropertyType.housing_society
    if _has(t, ["shop", "dukan", "dukaan", "office", "factory", "commercial", "business", "godown", "दुकान",
                "ऑफिस", "फैक्ट्री", "दफ्तर", "कमर्शियल"]):
        return PropertyType.commercial
    if _has(t, ["independent", "house", "ghar", "makaan", "makan", "bungalow", "villa", "घर", "मकान", "बंगला", "कोठी"]):
        return PropertyType.independent_house
    return None


def parse_roof_ownership(text: str) -> Optional[RoofOwnership]:
    t = text.lower()
    if _has(t, ["shared", "saajha", "sajha", "joint", "saanjha", "साझा", "सांझा"]):
        return RoofOwnership.shared
    if _has(t, ["kiray", "kiraye", "rent", "किराये", "किराए", "किराय"]):
        return RoofOwnership.rented
    if _has(t, ["own", "apna", "apni", "meri", "mera", "mine", "अपना", "अपनी", "मेरा", "मेरी", "मालिक"]):
        return RoofOwnership.owned
    return None


# ---------- DISCOM ----------

# Canonical name -> aliases (lowercase). Fill in the target state's list at setup.
DISCOMS = {
    "MSEDCL": ["msedcl", "mahavitaran", "mseb", "महावितरण"],
    "Torrent Power": ["torrent", "टोरेंट"],
    "Adani Electricity": ["adani", "अडानी"],
    "Tata Power": ["tata power", "tata", "टाटा"],
    "BEST": ["best", "बेस्ट"],
    "BSES Rajdhani": ["bses rajdhani", "rajdhani"],
    "BSES Yamuna": ["bses yamuna", "yamuna"],
    "TPDDL": ["tpddl", "tata power delhi"],
    "UPPCL": ["uppcl", "uttar pradesh power"],
    "PSPCL": ["pspcl", "punjab state power"],
    "BESCOM": ["bescom", "बेस्कॉम"],
    "TNPDCL": ["tangedco", "tnpdcl", "tneb"],
    "KSEB": ["kseb"],
    "TGSPDCL": ["tgspdcl", "tsspdcl"],
    "APSPDCL": ["apspdcl"],
    "DGVCL": ["dgvcl"],
    "MGVCL": ["mgvcl"],
    "UGVCL": ["ugvcl"],
    "PGVCL": ["pgvcl"],
    "JVVNL": ["jvvnl"],
    "MPPKVVCL": ["mppkvvcl", "mp poorv", "madhya pradesh poorv"],
}


def parse_discom(text: str) -> Optional[str]:
    t = text.lower()
    for canonical, aliases in DISCOMS.items():
        if any(re.search(r"(?<![a-z])" + re.escape(a) + r"(?![a-z])", t) for a in aliases):
            return canonical
    return None
