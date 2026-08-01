let storeInstance: any = null;

export async function getStore() {
  if (!storeInstance) {
    const Store = (await import('electron-store')).default;
    storeInstance = new Store();
  }
  return storeInstance;
}
