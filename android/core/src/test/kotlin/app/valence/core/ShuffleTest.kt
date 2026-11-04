package app.valence.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

class ShuffleTest {
    @Test
    fun orderIsAPermutationWithTheFirstSongLeading() {
        val keys = List(40) { "artist${it % 7}" }
        for (seed in 0 until 50) {
            val order = Shuffle.order(keys, 13, Random(seed))
            assertEquals(13, order.first())
            assertEquals(keys.indices.toList(), order.sorted())
        }
    }

    @Test
    fun orderWithoutAFirstSongIsStillAPermutation() {
        val keys = List(9) { "a" }
        val order = Shuffle.order(keys, null, Random(1))
        assertEquals(keys.indices.toList(), order.sorted())
        assertEquals(emptyList<Int>(), Shuffle.order(emptyList(), null, Random(1)))
        assertEquals(listOf(0), Shuffle.order(listOf("x"), 0, Random(1)))
    }

    @Test
    fun orderKeepsAnArtistsSongsApartWhenItCan() {
        // Four artists with five songs each: a spread order never needs two in a row.
        val keys = List(20) { "artist${it / 5}" }
        for (seed in 0 until 50) {
            val order = Shuffle.order(keys, 0, Random(seed))
            val adjacent = (1 until order.size).count { keys[order[it]] == keys[order[it - 1]] }
            assertTrue("seed $seed: $adjacent adjacent pairs", adjacent <= 1)
        }
    }

    @Test
    fun restoreUndoesAShuffle() {
        val before = listOf(10L, 11, 12, 13, 14, 15)
        // Shuffled while 12 played: 12 first, the rest at random.
        val now = listOf(12L, 15, 10, 14, 11, 13)
        val order = Shuffle.restore(now, before, current = 0)
        assertEquals(before, order.map { now[it] })
    }

    @Test
    fun restoreDropsRemovedSongsAndKeepsAddedOnesBesideThePlayingSong() {
        val before = listOf(1L, 2, 3, 4, 5)
        // Shuffled at song 3, then 4 was removed, 8 added before the playing song and 9 after it; 5 plays.
        val now = listOf(3L, 8, 1, 5, 9, 2)
        val order = Shuffle.restore(now, before, current = 3)
        assertEquals(listOf(1L, 2, 3, 8, 5, 9), order.map { now[it] })
    }

    @Test
    fun restoreWhenThePlayingSongWasAddedAfterTheShuffle() {
        val before = listOf(1L, 2, 3, 4)
        // Shuffled at 1: [1, 4, 2, 3]; then 9 was added after 4 and is playing.
        val now = listOf(1L, 4, 9, 2, 3)
        val order = Shuffle.restore(now, before, current = 2)
        assertEquals(listOf(1L, 2, 3, 4, 9), order.map { now[it] })
    }

    @Test
    fun restoreMatchesRepeatedSongsInOrder() {
        val before = listOf(1L, 2, 1, 3)
        val now = listOf(2L, 1, 3, 1)
        val order = Shuffle.restore(now, before, current = 0)
        assertEquals(before, order.map { now[it] })
        assertEquals(order.size, order.toSet().size)
    }
}
