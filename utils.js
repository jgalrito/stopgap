exports.readSample = (view, i, bytesPerSample) => {
	if(bytesPerSample === 3) {
		let sample = 0

		for(let j=0; j<bytesPerSample; j++)
			sample |= view.getUint8(i+j) << (8 * j)

		return sample & 0x800000 ? sample | 0xff000000 : sample
	}

	return view.getInt16(i, true)
}