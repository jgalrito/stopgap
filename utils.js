exports.readSample = (view, i, bytesPerSample) => {
	if(bytesPerSample === 3) {
		let sample = 0

		for(let j=0; j<bytesPerSample; j++)
			sample |= view.getUint8(i+j) << (8 * j)

		//sign extension for 32 bit
		return sample << 8 >> 8
	}

	return view.getInt16(i, true)
}