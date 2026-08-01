import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Windows-installatiemodi', () => {
  it('laat bij een losse installatie de map kiezen', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(pkg.build.nsis).toMatchObject({
      oneClick: false,
      allowToChangeInstallationDirectory: true,
      perMachine: false,
      selectPerMachineByDefault: false,
      allowElevation: true,
    })
  })
})
