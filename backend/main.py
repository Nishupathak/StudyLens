import os
import re
import json
import math
from collections import Counter

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from groq import Groq

load_dotenv()

client = Groq(api_key=os.getenv("GROQ_API_KEY"))
MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")

app = FastAPI(title="StudyLens")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------
def norm(s: str) -> str:
    return " ".join(s.split())


def parse_json(text: str) -> dict:
    text = text.strip()
    text = re.sub(r"^```(?:json)?|```$", "", text, flags=re.MULTILINE).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if match:
            return json.loads(match.group(0))
        raise


STOPWORDS = set("""a an the and or but if of to in on at by for with from as is are was
were be been being this that these those it its into about what which who whom how why
when where do does did can could should would will shall may might not no yes you your
me my we our they them their he she his her than then so such also any all some more
most other over under again very just page article tell explain summarize summary main
""".split())


def tokenize(s: str):
    return [w for w in re.findall(r"\w+", s.lower()) if len(w) > 2 and w not in STOPWORDS]


def split_chunks(text: str, size: int = 1200, overlap: int = 150):
    paragraphs = [p.strip() for p in re.split(r"\n+", text) if p.strip()]
    chunks, buf = [], ""
    for p in paragraphs:
        if len(buf) + len(p) + 1 <= size:
            buf = (buf + "\n" + p).strip()
        else:
            if buf:
                chunks.append(buf)
            while len(p) > size:
                chunks.append(p[:size])
                p = p[size - overlap:]
            buf = p
    if buf:
        chunks.append(buf)
    return chunks


def spread_context(text: str, limit: int = 10000) -> str:
    """Pick chunks evenly from the whole page (used for quizzes and flashcards)."""
    text = text.strip()
    if len(text) <= limit:
        return text
    chunks = split_chunks(text)
    per = max(1, limit // 1200)
    if len(chunks) <= per:
        return "\n\n".join(chunks)[:limit]
    step = len(chunks) / per
    picked = [chunks[int(i * step)] for i in range(per)]
    return "\n\n".join(picked)[:limit]


def retrieve(text: str, question: str, limit: int = 10000, top_k: int = 7) -> str:
    """Pick the chunks that best match the question (used for Ask)."""
    text = text.strip()
    if len(text) <= limit:
        return text
    chunks = split_chunks(text)
    q_tokens = set(tokenize(question))
    if not q_tokens:
        return spread_context(text, limit)

    docs = [Counter(tokenize(c)) for c in chunks]
    n = len(chunks)
    df = {t: sum(1 for d in docs if t in d) for t in q_tokens}

    scores = []
    for i, d in enumerate(docs):
        s = 0.0
        for t in q_tokens:
            if t in d:
                s += math.log(1 + n / df[t]) * (1 + math.log(d[t]))
        scores.append((s, i))

    scores.sort(reverse=True)
    top = [(s, i) for s, i in scores[:top_k] if s > 0]
    if not top:
        return spread_context(text, limit)
    idxs = sorted(i for _, i in top)
    return "\n\n".join(chunks[i] for i in idxs)[:limit]


# ---------------------------------------------------------------
# Health check
# ---------------------------------------------------------------
@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL}


# ---------------------------------------------------------------
# Ask (with citations)
# ---------------------------------------------------------------
class AskRequest(BaseModel):
    question: str
    page_text: str = ""
    url: str = ""


SYSTEM_PROMPT = """You answer questions using ONLY the page content provided.
Respond with a single JSON object and nothing else, in this exact shape:
{"answer": "your answer", "quotes": ["quote 1", "quote 2"]}

Rules:
- "quotes" must be 1 to 3 passages copied EXACTLY, word for word, from the page content.
- Each quote must be under 200 characters. Do not change, shorten with "...", or paraphrase them.
- If the page does not contain the answer, say so in "answer" and use an empty list for "quotes".
"""


@app.post("/ask")
def ask(req: AskRequest):
    context = retrieve(req.page_text, req.question)
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {
            "role": "user",
            "content": f"PAGE CONTENT:\n{context}\n\nQUESTION: {req.question}",
        },
    ]
    try:
        resp = client.chat.completions.create(
            model=MODEL, messages=messages, temperature=0
        )
        raw = resp.choices[0].message.content
    except Exception as e:
        return {"error": str(e)}

    try:
        data = parse_json(raw)
        answer = data.get("answer", "")
        quotes = data.get("quotes", [])
    except Exception:
        return {"answer": raw, "quotes": []}

    # Keep only quotes that really exist anywhere on the page
    page_norm = norm(req.page_text)
    verified = [q for q in quotes if isinstance(q, str) and norm(q) in page_norm]

    return {"answer": answer, "quotes": verified}


# ---------------------------------------------------------------
# Quiz
# ---------------------------------------------------------------
class QuizRequest(BaseModel):
    page_text: str
    count: int = 5
    language: str = "English"


QUIZ_PROMPT = """You are an exam-prep tutor. Create multiple-choice questions
using ONLY the page content provided.
Respond with a single JSON object and nothing else, in this exact shape:
{"questions": [{"question": "...", "options": ["A text", "B text", "C text", "D text"],
"answer_index": 0, "explanation": "one or two sentences"}]}

Rules:
- Exactly 4 options per question, and only one correct option.
- "answer_index" is the position (0 to 3) of the correct option.
- Wrong options must be plausible, not silly.
- Base every question on facts stated in the page content.
- Write everything in {language}.
"""


def build_quiz(context: str, count: int, language: str) -> dict:
    messages = [
        {"role": "system", "content": QUIZ_PROMPT.replace("{language}", language)},
        {
            "role": "user",
            "content": f"PAGE CONTENT:\n{context}\n\nCreate {count} questions.",
        },
    ]
    try:
        resp = client.chat.completions.create(
            model=MODEL, messages=messages, temperature=0.3
        )
        data = parse_json(resp.choices[0].message.content)
    except Exception as e:
        return {"error": f"Could not generate quiz: {e}"}

    valid = []
    for q in data.get("questions", []):
        opts = q.get("options", [])
        idx = q.get("answer_index")
        if (
            isinstance(q.get("question"), str)
            and isinstance(opts, list)
            and len(opts) == 4
            and isinstance(idx, int)
            and 0 <= idx <= 3
        ):
            valid.append(
                {
                    "question": q["question"],
                    "options": [str(o) for o in opts],
                    "answer_index": idx,
                    "explanation": str(q.get("explanation", "")),
                }
            )

    if not valid:
        return {"error": "There wasn't enough content for a quiz."}
    return {"questions": valid}


@app.post("/quiz")
def quiz(req: QuizRequest):
    count = max(1, min(req.count, 10))
    return build_quiz(spread_context(req.page_text), count, req.language)


# ---------------------------------------------------------------
# Flashcards
# ---------------------------------------------------------------
class CardsRequest(BaseModel):
    page_text: str
    count: int = 8
    language: str = "English"


CARDS_PROMPT = """You are an exam-prep tutor. Create flashcards using ONLY the
page content provided.
Respond with a single JSON object and nothing else, in this exact shape:
{"cards": [{"front": "question or term", "back": "short answer or definition"}]}

Rules:
- Each card tests exactly ONE fact.
- "front" must be under 150 characters and "back" under 250 characters.
- Base every card on facts stated in the page content.
- Write everything in {language}.
"""


@app.post("/flashcards")
def flashcards(req: CardsRequest):
    count = max(1, min(req.count, 15))
    context = spread_context(req.page_text)
    messages = [
        {"role": "system", "content": CARDS_PROMPT.replace("{language}", req.language)},
        {
            "role": "user",
            "content": f"PAGE CONTENT:\n{context}\n\nCreate {count} flashcards.",
        },
    ]
    try:
        resp = client.chat.completions.create(
            model=MODEL, messages=messages, temperature=0.3
        )
        data = parse_json(resp.choices[0].message.content)
    except Exception as e:
        return {"error": f"Could not generate flashcards: {e}"}

    cards = []
    for c in data.get("cards", []):
        front, back = c.get("front"), c.get("back")
        if isinstance(front, str) and isinstance(back, str) and front.strip() and back.strip():
            cards.append({"front": front.strip(), "back": back.strip()})

    if not cards:
        return {"error": "The page didn't have enough content for flashcards."}
    return {"cards": cards}


# ---------------------------------------------------------------
# Library answer (stateless: the extension sends the notes)
# ---------------------------------------------------------------
class Note(BaseModel):
    n: int
    title: str = ""
    content: str


class LibAskRequest(BaseModel):
    question: str
    notes: list[Note]


LIB_PROMPT = """You answer questions using ONLY the saved notes provided.
Each note starts with a source number like [1].
Rules:
- Cite the source numbers you used in square brackets, like [1] or [2][3].
- If the notes do not contain the answer, say you could not find it in the saved pages.
- Keep the answer short and clear.
"""


@app.post("/library/ask")
def library_ask(req: LibAskRequest):
    if not req.notes:
        return {"error": "No notes were provided."}

    blocks = [f"[{n.n}] {n.title}\n{n.content}" for n in req.notes]
    notes_text = "\n\n".join(blocks)[:14000]

    messages = [
        {"role": "system", "content": LIB_PROMPT},
        {
            "role": "user",
            "content": f"SAVED NOTES:\n\n{notes_text}\n\nQUESTION: {req.question}",
        },
    ]
    try:
        resp = client.chat.completions.create(model=MODEL, messages=messages, temperature=0)
        return {"answer": resp.choices[0].message.content}
    except Exception as e:
        return {"error": str(e)}
    # ---------------------------------------------------------------
# Fact-check (web search + verdict)
# ---------------------------------------------------------------
import httpx

TAVILY_KEY = os.getenv("TAVILY_API_KEY")


class FactRequest(BaseModel):
    claim: str


FACT_PROMPT = """You are a careful fact-checker. You are given a CLAIM and numbered WEB RESULTS.
Judge the claim using ONLY the web results. Do not use your own knowledge.
Respond with a single JSON object and nothing else, in this exact shape:
{"verdict": "Supported", "summary": "2 to 3 sentences explaining the verdict",
"evidence": [{"n": 1, "stance": "supports", "note": "one short sentence"}]}

Rules:
- "verdict" must be exactly one of: Supported, Disputed, Mixed, Not enough evidence.
- "stance" must be exactly one of: supports, disputes, neutral.
- "n" is the number of a web result. Only use numbers that exist.
- Use "Not enough evidence" if the results do not clearly address the claim.
- Use "Mixed" if good sources disagree or only partly support the claim.
- Keep each note under 160 characters.
"""

VERDICTS = {"supported": "Supported", "disputed": "Disputed", "mixed": "Mixed",
            "not enough evidence": "Not enough evidence"}


def web_search(query: str, max_results: int = 5):
    resp = httpx.post(
        "https://api.tavily.com/search",
        headers={"Authorization": f"Bearer {TAVILY_KEY}"},
        json={"query": query, "max_results": max_results, "search_depth": "basic"},
        timeout=25,
    )
    resp.raise_for_status()
    return resp.json().get("results", [])


@app.post("/factcheck")
def factcheck(req: FactRequest):
    claim = norm(req.claim)[:380]
    if len(claim) < 15:
        return {"error": "Select or type a full sentence to check."}
    if not TAVILY_KEY:
        return {"error": "Missing TAVILY_API_KEY in backend/.env (then restart the server)."}

    results, seen = [], set()
    try:
        for q in (claim, f"{claim} fact check"):
            for r in web_search(q):
                url = r.get("url")
                if url and url not in seen:
                    seen.add(url)
                    results.append(r)
    except Exception as e:
        return {"error": f"Web search failed: {e}"}

    results = results[:8]
    if not results:
        return {"error": "No web results found for this claim."}

    blocks = [
        f"[{i}] {r.get('title', '')}\n{(r.get('content') or '')[:700]}"
        for i, r in enumerate(results, 1)
    ]
    messages = [
        {"role": "system", "content": FACT_PROMPT},
        {
            "role": "user",
            "content": f"CLAIM: {claim}\n\nWEB RESULTS:\n\n" + "\n\n".join(blocks),
        },
    ]
    try:
        resp = client.chat.completions.create(model=MODEL, messages=messages, temperature=0)
        data = parse_json(resp.choices[0].message.content)
    except Exception as e:
        return {"error": f"Could not analyse the results: {e}"}

    verdict = VERDICTS.get(str(data.get("verdict", "")).strip().lower(), "Not enough evidence")

    sources = []
    for ev in data.get("evidence", []):
        n = ev.get("n")
        if not isinstance(n, int) or not (1 <= n <= len(results)):
            continue
        stance = str(ev.get("stance", "neutral")).lower()
        if stance not in ("supports", "disputes", "neutral"):
            stance = "neutral"
        r = results[n - 1]
        sources.append(
            {
                "title": r.get("title") or r["url"],
                "url": r["url"],
                "stance": stance,
                "note": str(ev.get("note", ""))[:200],
            }
        )

    return {"verdict": verdict, "summary": str(data.get("summary", "")), "sources": sources}