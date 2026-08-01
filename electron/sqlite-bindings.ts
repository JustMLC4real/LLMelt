export function providerLimitUpdateBindings<T extends { id: string }>(row: T): Omit<T, 'id'> {
  const { id: _primaryKey, ...bindings } = row;
  return bindings;
}
