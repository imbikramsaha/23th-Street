const WORDS = 7776
let list = null

function wordlist() {
  list ??= fetch(new URL('./vendor/eff-large-wordlist.txt', import.meta.url))
    .then(res => {
      if (!res.ok) throw new Error('Word list failed to load')
      return res.text()
    })
    .then(text => {
      const words = text.split('\n').map(w => w.trim()).filter(Boolean)
      if (words.length !== WORDS) throw new Error('Word list is incomplete')
      return words
    })
    .catch(err => {
      list = null
      throw err
    })
  return list
}

function randomIndex(n) {
  const limit = Math.floor(0x100000000 / n) * n
  const buf = new Uint32Array(1)
  do crypto.getRandomValues(buf)
  while (buf[0] >= limit)
  return buf[0] % n
}

export async function generatePassphrase(count = 6) {
  const words = await wordlist()
  return Array.from({ length: count }, () => words[randomIndex(words.length)]).join(' ')
}
