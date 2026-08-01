import { describe, expect, it } from 'vitest'
import { selectAgentToolProtocol, shouldStartNativeToolTurn, shouldUseTagToolProtocol } from '../electron/native-tool-policy'

describe('native toolrouting', () => {
  it('biedt bij gewone lokale chatvragen geen PC-tools aan', () => {
    expect(shouldStartNativeToolTurn({
      toolsEnabled: true,
      modelToolCapable: true,
      userInput: 'hey',
    })).toBe(false)
    expect(shouldStartNativeToolTurn({
      toolsEnabled: true,
      modelToolCapable: true,
      userInput: 'waarom zijn paarden zwart',
    })).toBe(false)
  })

  it('start de native toolroute voor een echte bestands- en uitvoeropdracht', () => {
    expect(shouldStartNativeToolTurn({
      toolsEnabled: true,
      modelToolCapable: true,
      userInput: 'maak hello.py en voer het script uit',
    })).toBe(true)
  })

  it('respecteert zowel de globale toolswitch als de live modelcapability', () => {
    expect(shouldStartNativeToolTurn({
      toolsEnabled: false,
      modelToolCapable: true,
      userInput: 'maak hello.py',
    })).toBe(false)
    expect(shouldStartNativeToolTurn({
      toolsEnabled: true,
      modelToolCapable: false,
      userInput: 'maak hello.py',
    })).toBe(false)
  })

  it('gebruikt tag-tools uitsluitend voor modellen zonder native toolprotocol', () => {
    expect(selectAgentToolProtocol({
      toolsEnabled: true,
      modelToolCapable: false,
    })).toBe('tags')
    expect(selectAgentToolProtocol({
      toolsEnabled: true,
      modelToolCapable: true,
    })).toBe('native')
    expect(selectAgentToolProtocol({
      toolsEnabled: false,
      modelToolCapable: false,
    })).toBe('none')
    expect(shouldUseTagToolProtocol({
      toolsEnabled: true,
      modelToolCapable: true,
    })).toBe(false)
    expect(shouldUseTagToolProtocol({
      toolsEnabled: true,
      modelToolCapable: false,
    })).toBe(true)
    expect(shouldUseTagToolProtocol({
      toolsEnabled: false,
      modelToolCapable: false,
    })).toBe(false)
  })
})
