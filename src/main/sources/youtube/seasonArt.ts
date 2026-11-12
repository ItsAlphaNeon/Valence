// Built-in SiIvaGunner season covers (1200px JPEGs in resources/seasons), keyed by season key.
// A season the user added or re-keyed has none and falls back to the generated placeholder.
import s1 from '../../../../resources/seasons/s1.jpg?asset'
import s2 from '../../../../resources/seasons/s2.jpg?asset'
import s3 from '../../../../resources/seasons/s3.jpg?asset'
import s4 from '../../../../resources/seasons/s4.jpg?asset'
import s4e2 from '../../../../resources/seasons/s4e2.jpg?asset'
import s5 from '../../../../resources/seasons/s5.jpg?asset'
import s6 from '../../../../resources/seasons/s6.jpg?asset'
import s7 from '../../../../resources/seasons/s7.jpg?asset'
import s8 from '../../../../resources/seasons/s8.jpg?asset'
import s9 from '../../../../resources/seasons/s9.jpg?asset'
import sx from '../../../../resources/seasons/sx.jpg?asset'

/** Bump when the art changes, so rips already carrying the old art get the new one at startup. */
export const BUILTIN_ART_VERSION = 1

export const BUILTIN_SEASON_ART: Readonly<Record<string, string>> = { s1, s2, s3, s4, s4e2, s5, s6, s7, s8, s9, sx }
