package app.valence.core

data class LyricLine(val timeMs: Long, val text: String)

private val LRC_TIME = Regex("\\[(\\d{1,3}):(\\d{2})(?:[.:](\\d{1,3}))?]")
private val WORD_TIME = Regex("<\\d{1,3}:\\d{2}(?:[.:]\\d{1,3})?>")
private val LRC_OFFSET = Regex("^\\[offset:\\s*([+-]?\\d+)]", RegexOption.IGNORE_CASE)

/** Parses LRC (synced) lyrics; null when the text isn't LRC. */
fun parseLrc(text: String): List<LyricLine>? {
    val out = ArrayList<LyricLine>()
    var offset = 0L
    for (raw in text.lineSequence()) {
        val line = raw.trim()
        LRC_OFFSET.find(line)?.let { offset = it.groupValues[1].toLongOrNull() ?: 0L }
        val stamps = LRC_TIME.findAll(line).toList()
        if (stamps.isEmpty() || stamps.first().range.first != 0) continue
        val words = line.substring(stamps.last().range.last + 1).replace(WORD_TIME, "").trim()
        for (m in stamps) {
            val min = m.groupValues[1].toLong()
            val sec = m.groupValues[2].toLong()
            val frac = m.groupValues[3]
            val ms = when (frac.length) { 0 -> 0L; 1 -> frac.toLong() * 100; 2 -> frac.toLong() * 10; else -> frac.take(3).toLong() }
            out.add(LyricLine(min * 60_000 + sec * 1000 + ms - offset, words))
        }
    }
    return if (out.isEmpty()) null else out.sortedBy { it.timeMs }
}
