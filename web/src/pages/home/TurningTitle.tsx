import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import styles from './TurningTitle.module.css'

const TURN_MS = 2_400

/**
 * "Bora <word> junto?" with the word turning every 2.4 s: the new one rises
 * from below out of a blur on the spring, the old one leaves upward. Screen
 * readers hear the first word only, once.
 */
export function TurningTitle({ before, after, words, className }: {
  before: string
  after: string
  words: readonly string[]
  className?: string
}) {
  const [turn, setTurn] = useState(0)
  // The turn whose old word has finished leaving: it stops holding the width.
  const [gone, setGone] = useState(0)

  useEffect(() => {
    if (words.length < 2) return undefined
    const timer = window.setInterval(() => setTurn((value) => value + 1), TURN_MS)
    return () => window.clearInterval(timer)
  }, [words.length])

  const word = words[turn % words.length] ?? ''
  // The slot eases to each word's width, so "Bora" and the rest of the
  // centred line glide instead of jumping when a longer word comes.
  const measure = useRef<HTMLSpanElement>(null)
  const [width, setWidth] = useState<number | null>(null)
  useLayoutEffect(() => {
    const node = measure.current
    if (!node) return undefined
    const read = () => setWidth(node.getBoundingClientRect().width)
    read()
    // Fonts arriving late change every width.
    const observer = new ResizeObserver(read)
    observer.observe(node)
    return () => observer.disconnect()
  }, [word])
  const leaving = turn > 0 && gone !== turn ? words[(turn - 1) % words.length] : null

  return (
    <h1 className={className} aria-live="off">
      <span className={styles.readable}>{`${before} ${words[0] ?? ''} ${after}`}</span>
      <span aria-hidden="true">
        {before}{' '}
        <span className={styles.slot} style={width === null ? undefined : { width }}>
          <span className={styles.strut}>{word}</span>
          <span ref={measure} className={styles.measure}>{word}</span>
          {leaving !== null ? <span key={`out-${turn}`} className={styles.leave} onAnimationEnd={() => setGone(turn)}>{leaving}</span> : null}
          <span key={`in-${turn}`} className={turn > 0 ? styles.enter : styles.word}>{word}</span>
        </span>
        <br />
        {after}
      </span>
    </h1>
  )
}
