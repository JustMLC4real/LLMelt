import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

describe('LLMelt-productbranding', () => {
  it('gebruikt de nieuwe package- en productnaam met de bestaande update-identiteit', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.name).toBe('LLMelt');
    expect(pkg.build.productName).toBe('LLMelt');
    expect(pkg.build.appId).toBe('com.superapp.ai');
    expect(pkg.build.artifactName).toBe('${productName}-Setup-${version}.${ext}');
  });

  it('gebruikt uitsluitend de publieke GitHub Releases-pagina als updateserver', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.repository.url).toBe('https://github.com/JustMLC4real/LLMelt.git');
    // Geen releaseType: dat veld stuurt alleen electron-builder bij publiceren
    // met --publish, en dat doet dit project niet. De updater kijkt uitsluitend
    // naar autoUpdater.allowPrerelease, dat vanuit het updatekanaal wordt gezet.
    expect(pkg.build.publish).toEqual([{
      provider: 'github',
      owner: 'JustMLC4real',
      repo: 'LLMelt',
    }]);
    expect(pkg.updateChannel).toBeDefined();

    const publishScript = readFileSync(new URL('../scripts/publish-update.mjs', import.meta.url), 'utf8');
    expect(publishScript).toContain("const repository = 'JustMLC4real/LLMelt'");
    expect(publishScript).not.toContain('scp');
    expect(publishScript).toContain("branch !== 'main'");
    expect(publishScript).toContain("'refs/heads/main'");
    expect(publishScript).toContain('asset.digest !== localDigest');
    expect(publishScript).toContain("method: 'HEAD'");
    expect(publishScript).toContain('remoteManifestHash !== actualHash');
    expect(publishScript).toContain('!release.isPrerelease');
    expect(publishScript).toContain('manifestVersion !== version');
    expect(publishScript).toContain('manifestSize !== statSync(installer).size');
  });

  it('heeft de definitieve renderer- en Windows-iconen', () => {
    for (const relativePath of ['../public/icon-source.png', '../public/icon.png', '../public/icon.ico']) {
      const file = new URL(relativePath, import.meta.url);
      expect(existsSync(file)).toBe(true);
      expect(statSync(file).size).toBeGreaterThan(1_000);
    }
  });

  it('heeft een transparante PNG-rand zonder zwarte halo', async () => {
    const { data, info } = await sharp(fileURLToPath(new URL('../public/icon.png', import.meta.url)))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let softEdgePixels = 0;
    let darkSoftEdgePixels = 0;

    for (let offset = 0; offset < data.length; offset += info.channels) {
      const alpha = data[offset + 3];
      if (alpha === 0 || alpha === 255) continue;
      softEdgePixels += 1;
      if (Math.max(data[offset], data[offset + 1], data[offset + 2]) < 80) {
        darkSoftEdgePixels += 1;
      }
    }

    expect(softEdgePixels).toBeGreaterThan(0);
    expect(darkSoftEdgePixels / softEdgePixels).toBeLessThan(0.01);
  });

  it('bewaart alle Windows-ICO-formaten als PNG met echte alpha', async () => {
    const ico = readFileSync(new URL('../public/icon.ico', import.meta.url));
    const count = ico.readUInt16LE(4);
    expect(count).toBe(6);

    for (let index = 0; index < count; index += 1) {
      const entry = 6 + (index * 16);
      const size = ico.readUInt32LE(entry + 8);
      const offset = ico.readUInt32LE(entry + 12);
      const image = ico.subarray(offset, offset + size);
      expect(image.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect((await sharp(image).metadata()).hasAlpha).toBe(true);
    }
  });

  it('toont LLMelt als documenttitel', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    expect(html).toContain('<title>LLMelt</title>');
    expect(html).not.toContain('<title>AI Superapp</title>');
  });

  it('heeft een publieke product-README met lokale, veilige preview-assets', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    expect(readme).toContain('<h1 align="center">LLMelt</h1>');
    expect(readme).toContain('https://github.com/JustMLC4real/LLMelt/releases/latest');
    expect(readme).toContain('./docs/README.md');
    expect(readme).not.toContain('AI Superapp');
    expect(readme).not.toContain('LLMeld');

    for (const relativePath of [
      '../docs/assets/readme/tour.gif',
      '../docs/assets/readme/chat-demo.gif',
      '../docs/assets/readme/welcome.png',
      '../docs/assets/readme/providers.png',
      '../docs/assets/readme/provider-check.png',
      '../docs/assets/readme/chat-model-selected.png',
      '../docs/assets/readme/chat-prompt.png',
      '../docs/assets/readme/chat-response.png',
    ]) {
      const asset = new URL(relativePath, import.meta.url);
      expect(existsSync(asset)).toBe(true);
      expect(statSync(asset).size).toBeGreaterThan(10_000);
    }
  });

  it('gebruikt een vloeiende, echt bediende chatopname in plaats van een screenshot-slideshow', async () => {
    const captureScript = readFileSync(new URL('../scripts/capture-readme-screenshots.mjs', import.meta.url), 'utf8');
    expect(captureScript).toContain("process.argv.includes('--live-chat')");
    expect(captureScript).toContain("'Input.dispatchMouseEvent'");
    expect(captureScript).toContain("'Input.insertText'");
    expect(captureScript).not.toContain('function generateChatDemoGif');

    const gif = new URL('../docs/assets/readme/chat-demo.gif', import.meta.url);
    const metadata = await sharp(fileURLToPath(gif), { animated: true }).metadata();
    expect(statSync(gif).size).toBeGreaterThan(500_000);
    expect(metadata.pages).toBeGreaterThan(100);
  });

  it('gebruikt renderer-iconen die ook onder file:// relatief oplossen', () => {
    for (const relativePath of [
      './components/Titlebar.tsx',
      './components/ChatView.tsx',
      './components/OnboardingGuide.tsx',
    ]) {
      const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
      expect(source).toContain('src="./icon.png"');
      expect(source).not.toContain('src="/icon.png"');
    }

    expect(new URL('./icon.png', 'file:///C:/Program%20Files/LLMelt/resources/app/dist/index.html').href)
      .toBe('file:///C:/Program%20Files/LLMelt/resources/app/dist/icon.png');
  });
});
