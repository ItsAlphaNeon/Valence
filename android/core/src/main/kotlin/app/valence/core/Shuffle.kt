package app.valence.core

import kotlin.random.Random

/**
 * Shuffle the desktop's way (src/renderer/audio/queue.ts): a random order that spreads each
 * artist's songs across the list with the playing song first, and the way back to the order the
 * list had before it was shuffled.
 */
object Shuffle {
    /**
     * A random order of the positions of [keys] (one artist key per song) that keeps songs with the
     * same key apart where it can. [first], when given, leads.
     */
    fun order(keys: List<String>, first: Int?, rng: Random = Random.Default): List<Int> {
        val lead = first?.takeIf { it in keys.indices }
        val order = spread(keys.indices.filter { it != lead }, keys, rng).toMutableList()
        if (lead != null) order.add(0, lead)
        return repairAdjacent(order, keys)
    }

    /** Each key's songs spaced evenly through the list, with a little jitter (the desktop's spreadByArtist). */
    private fun spread(idx: List<Int>, keys: List<String>, rng: Random): List<Int> {
        val groups = LinkedHashMap<String, MutableList<Int>>()
        for (i in idx) groups.getOrPut(keys[i]) { mutableListOf() }.add(i)
        val placed = ArrayList<Pair<Int, Double>>(idx.size)
        for (g in groups.values) {
            g.shuffle(rng)
            val n = g.size
            val off = rng.nextDouble() / n
            g.forEachIndexed { k, i -> placed.add(i to off + k.toDouble() / n + (rng.nextDouble() - 0.5) * 0.2 / n) }
        }
        placed.sortBy { it.second }
        return placed.map { it.first }
    }

    /** Swaps away adjacent same-key pairs where a swap creates no new pair. Position 0 stays put. */
    private fun repairAdjacent(order: MutableList<Int>, keys: List<String>): List<Int> {
        val n = order.size
        fun k(p: Int): String? = if (p in 0 until n) keys[order[p]] else null
        fun fits(v: String, p: Int, skip: Int) = (p - 1 == skip || k(p - 1) != v) && (p + 1 == skip || k(p + 1) != v)
        for (i in 1 until n) {
            if (k(i) != k(i - 1)) continue
            val ki = k(i)!!
            search@ for (d in 1 until n) {
                for (j in intArrayOf(i + d, i - d)) {
                    if (j < 1 || j >= n || j == i) continue
                    val kj = k(j)!!
                    if (kj == ki) continue
                    if (fits(kj, i, j) && fits(ki, j, i)) {
                        val t = order[i]
                        order[i] = order[j]
                        order[j] = t
                        break@search
                    }
                }
            }
        }
        return order
    }

    /**
     * Undoing a shuffle: the positions of [now] (the queue as it is, song ids) in the order of
     * [before] (the queue before it was shuffled), as old positions in their new order.
     *
     * Songs removed since the shuffle are gone. Songs added since stay beside the playing song
     * ([current]) on the side they were on, like the desktop's Up Next. When the playing song was
     * itself added since, it and those songs go after the last original song that had already played.
     * Repeated songs are matched in order.
     */
    fun restore(now: List<Long>, before: List<Long>, current: Int): List<Int> {
        val pool = HashMap<Long, ArrayDeque<Int>>()
        now.forEachIndexed { i, id -> pool.getOrPut(id) { ArrayDeque() }.addLast(i) }
        val base = ArrayList<Int>(now.size)
        for (id in before) pool[id]?.removeFirstOrNull()?.let(base::add)
        val extras = pool.values.flatten().sorted()
        if (extras.isEmpty()) return base
        if (current !in now.indices) return base + extras
        val at = base.indexOf(current)
        val insertAt = if (at >= 0) {
            base.removeAt(at)
            at
        } else {
            // The playing song was added after the shuffle: follow the last original song before it.
            val anchor = (current - 1 downTo 0).firstOrNull { it in base }
            if (anchor == null) 0 else base.indexOf(anchor) + 1
        }
        val block = extras.filter { it < current } + current + extras.filter { it > current }
        base.addAll(insertAt, block)
        return base
    }
}
