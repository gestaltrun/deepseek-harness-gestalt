import { writeFileSync } from 'node:fs'

const pidFile = process.env.DSH_TEST_PID_FILE
if (pidFile === undefined) throw new Error('DSH_TEST_PID_FILE is required')
writeFileSync(pidFile, String(process.pid))
console.error('fixture waiting without a URL')
if (process.env.DSH_TEST_API_KEY !== undefined) console.error(`fixture key ${process.env.DSH_TEST_API_KEY}`)
setInterval(() => {}, 1 << 30)
