package app.valence.core

import java.math.BigDecimal
import java.math.BigInteger
import java.math.MathContext
import java.math.RoundingMode
import java.util.Locale
import kotlin.math.floor

/**
 * JavaScript semantics the desktop relies on implicitly: `\s` / `trim()`, `Number()`, truthiness,
 * `Math.round`, `String(x)`. Parsed JSON values are modelled as: [JsonNull] for JSON `null`, Kotlin
 * `null` for `undefined` (a missing key), [Double], [String], [Boolean], [List], [Map].
 */
internal object Js {
    /** JS `\s` and the set `String.prototype.trim` strips (WhiteSpace + LineTerminator). */
    fun isSpace(c: Char): Boolean = when (c) {
        '\t', '\n', '\u000B', '\u000C', '\r', ' ', ' ', ' ', ' ', ' ', ' ', ' ', '　', '﻿' -> true
        else -> c in ' '..' '
    }

    /** What JS regex `.` does not match. */
    fun isLineTerminator(c: Char): Boolean = c == '\n' || c == '\r' || c == ' ' || c == ' '

    fun trim(s: String): String {
        var a = 0
        var b = s.length
        while (a < b && isSpace(s[a])) a++
        while (b > a && isSpace(s[b - 1])) b--
        return if (a == 0 && b == s.length) s else s.substring(a, b)
    }

    /** `s.replace(/\s+/g, ' ')` */
    fun collapseSpaces(s: String): String {
        val sb = StringBuilder(s.length)
        var inRun = false
        for (c in s) {
            if (isSpace(c)) {
                if (!inRun) sb.append(' ')
                inRun = true
            } else {
                sb.append(c)
                inRun = false
            }
        }
        return sb.toString()
    }

    /** `toLowerCase()` (locale-independent full Unicode mapping, final sigma included). */
    fun lower(s: String): String = s.lowercase(Locale.ROOT)

    /** `Math.round`: nearest integer, ties toward +Infinity. */
    fun round(x: Double): Double {
        if (x.isNaN() || x.isInfinite()) return x
        val f = floor(x)
        val r = if (x - f >= 0.5) f + 1 else f
        return if (r == 0.0 && (x < 0 || (x == 0.0 && 1 / x < 0))) -0.0 else r
    }

    /** Double -> Long the way a JS integer-valued number would be stored; NaN/Infinity become 0. */
    fun toLong(x: Double): Long = if (x.isNaN() || x.isInfinite()) 0L else x.toLong()

    private val DECIMAL = Regex("[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?")

    /** `Number(string)`. */
    fun toNumber(str: String): Double {
        val s = trim(str)
        if (s.isEmpty()) return 0.0
        if (s.length > 2 && s[0] == '0') {
            val radix = when (s[1]) {
                'x', 'X' -> 16
                'o', 'O' -> 8
                'b', 'B' -> 2
                else -> 0
            }
            if (radix != 0) {
                val digits = s.substring(2)
                if (digits.all { Character.digit(it, radix) >= 0 && it.code < 128 }) return BigInteger(digits, radix).toDouble()
                return Double.NaN
            }
        }
        when (s) {
            "Infinity", "+Infinity" -> return Double.POSITIVE_INFINITY
            "-Infinity" -> return Double.NEGATIVE_INFINITY
        }
        if (!DECIMAL.matches(s)) return Double.NaN
        return s.toDouble()
    }

    /** `Number(v)` for a parsed JSON value. */
    fun toNumber(v: Any?): Double = when (v) {
        null -> Double.NaN
        JsonNull -> 0.0
        is Boolean -> if (v) 1.0 else 0.0
        is Double -> v
        is Number -> v.toDouble()
        is String -> toNumber(v)
        is List<*> -> toNumber(toJsString(v))
        else -> Double.NaN
    }

    /** JS truthiness of a parsed JSON value. */
    fun truthy(v: Any?): Boolean = when (v) {
        null, JsonNull -> false
        is Boolean -> v
        is Double -> !(v == 0.0 || v.isNaN())
        is Number -> v.toDouble().let { !(it == 0.0 || it.isNaN()) }
        is String -> v.isNotEmpty()
        else -> true
    }

    /** `String(v)` for a parsed JSON value. */
    fun toJsString(v: Any?): String = when (v) {
        null -> "undefined"
        JsonNull -> "null"
        is Boolean -> v.toString()
        is Double -> numberToString(v)
        is Number -> numberToString(v.toDouble())
        is String -> v
        is List<*> -> v.joinToString(",") { if (it == null || it == JsonNull) "" else toJsString(it) }
        else -> "[object Object]"
    }

    /** `Number.prototype.toString()` (shortest round-trip digits, JS exponent rules). */
    fun numberToString(d: Double): String {
        if (d.isNaN()) return "NaN"
        if (d == 0.0) return "0"
        if (d.isInfinite()) return if (d > 0) "Infinity" else "-Infinity"
        if (d < 0) return "-" + numberToString(-d)
        if (d == floor(d) && d < 9007199254740992.0) return d.toLong().toString()
        val exact = BigDecimal(d)
        var digits = ""
        var n = 0
        for (p in 1..17) {
            val r = exact.round(MathContext(p, RoundingMode.HALF_EVEN))
            if (r.toDouble() == d) {
                val u = r.unscaledValue().abs().toString().trimEnd('0')
                digits = u.ifEmpty { "0" }
                n = r.precision() - r.scale()
                break
            }
        }
        val k = digits.length
        return when {
            n in k..21 -> digits + "0".repeat(n - k)
            n in 1..21 -> digits.substring(0, n) + "." + digits.substring(n)
            n in -5..0 -> "0." + "0".repeat(-n) + digits
            else -> {
                val e = n - 1
                val exp = (if (e >= 0) "+" else "-") + kotlin.math.abs(e)
                if (k == 1) "${digits}e$exp" else "${digits[0]}.${digits.substring(1)}e$exp"
            }
        }
    }
}

/** JSON `null` (Kotlin `null` stands for JS `undefined`, i.e. a missing key). */
internal object JsonNull {
    override fun toString() = "null"
}
