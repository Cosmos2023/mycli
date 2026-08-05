export function compareUnicodeCodePoints(left: string, right: string): number {
	const leftCharacters = Array.from(left);
	const rightCharacters = Array.from(right);
	const sharedLength = Math.min(leftCharacters.length, rightCharacters.length);
	for (let index = 0; index < sharedLength; index += 1) {
		const difference = leftCharacters[index]!.codePointAt(0)!
			- rightCharacters[index]!.codePointAt(0)!;
		if (difference !== 0) return difference;
	}
	return leftCharacters.length - rightCharacters.length;
}
