const
	{ app, BrowserWindow, ipcMain } = require('electron'),
	fs = require('fs')

require('electron-reload')(__dirname)

const CACHE_LEVELS = [5, 8, 10, 12, 14]

let loadedFile,
	loadedFileHeader,
	cachedChunks = {}

const
	pipeAsync = (...fns) => async arg => {
		for(let fn of fns)
			arg = await fn(arg)

		return arg
	},
	reader = (fd, cursor = 0) => [{fd, cursor}],
	read = n => ([{fd, cursor, ...state}]) => new Promise((resolve, reject) =>
		fs.read(fd, Buffer.alloc(n), 0, n, cursor, (err, bytesRead, buf) => {
			if(err)
				return reject(err)
			
			resolve([{
				...state,
				fd,
				cursor: cursor + bytesRead,
			}, buf])
		})),
	readString = pipeAsync(
		read(4),
		([state, res]) => [state, res.toString()]),
	readInt = pipeAsync(
		read(4),
		([state, res]) => [state, res.readUInt32LE()]),
	read16Int = pipeAsync(
		read(2),
		([state, res]) => [state, res.readUInt16LE()]),
	store = id => ([state, res]) => [{
		...state,
		data: {
			...(state.data || {}),
			[id]: res
		}
	}],
	readChunkHeader = async ([{fd, cursor, data}]) => {
		const [state] = await pipeAsync(
			readString, store('id'),
			readInt, store('size')
		)(reader(fd, cursor))

		return [{ ...state, data }, state.data]
	},
	getCursor = ([state]) => [state, state.cursor]

const readMeta = async ([state]) => {
	const chunks = []

	let done = false

	while(!done)
		[state] = await pipeAsync(
			readChunkHeader,
			async ([state, chunk]) => {
				if(chunk.id !== 'data')
					[state] = await pipeAsync(
						read(chunk.size),
						([state, data]) => {
							chunk.data = data

							return [state]
						}
					)([state])
				else done = true

				chunks.push(chunk)

				return [state]
			}
		)([state])

	return [state, chunks]
}

const readHeader = pipeAsync(
	reader,
	readString,	store('ChunkID'),
	readInt,	store('ChunkSize'),
	readString, store('Format'),
	readString, store('Subchunk1ID'),
	readInt,	store('Subchunk1Size'),
	read16Int,	store('AudioFormat'),
	read16Int,	store('NumChannels'),
	readInt,	store('SampleRate'),
	readInt,	store('ByteRate'),
	read16Int,	store('BlockAlign'),
	read16Int,	store('BitsPerSample'),
	readMeta,	store('Meta'),
	getCursor,	store('DataOffset'),
	([{data}]) => data
)

const getSamples = () => new Promise((resolve, reject) => {
	const size = loadedFileHeader.Meta.find(({id}) => id === 'data').size

	fs.read(loadedFile, Buffer.alloc(size), 0, size, loadedFileHeader.DataOffset, (err, bytesRead, data) => {
		if(err)
			reject(err)
		else {
			const
				view = new DataView(data.buffer),
				res = []

			for(let i=0; i<data.length; i+=loadedFileHeader.BlockAlign) {
				let sample = 0

				for(let j=0; j<loadedFileHeader.BlockAlign; j++)
					sample += view.getInt8(i+j) << (8 * j)

				res.push(sample)
			}

			resolve(res)
		}
	})
})

const generateCache = (cacheLevel, prevCacheLevel, prevCache) => {
	const
		oldChunksPerNewChunk = Math.pow(2, cacheLevel - prevCacheLevel),
		cache = []

	for(let i=0; i<prevCache.length; i+=oldChunksPerNewChunk) {
		let min, max

		for(let j=0; j<oldChunksPerNewChunk && i+j<prevCache.length; j++) {
			if(!min || min > prevCache[i+j][0])
				min = prevCache[i+j][0]

			if(!max || max < prevCache[i+j][1])
				max = prevCache[i+j][1]			
		}

		cache.push([min, max])
	}

	return cache
}

const cacheChunks = async () => {
	const
		caches = [],
		samples = await getSamples(),
		resolution = Math.pow(2, CACHE_LEVELS[0]),
		cache = []

	for(let i=0; i<samples.length; i+=resolution) {
		let min, max

		for(let j=0; j<resolution; j++) {
			if(!min || min > samples[i+j])
				min = samples[i+j]

			if(!max || max < samples[i+j])
				max = samples[i+j]
		}

		cache.push([min, max])
	}

	caches.push(cache)

	for(let i=1; i<CACHE_LEVELS.length; i++)
		caches.push(generateCache(CACHE_LEVELS[i], CACHE_LEVELS[i-1], caches[i-1]))

	return caches
}

ipcMain.on('load-file', (e, path) => {
	fs.open(path, async (err, fd) => {
		if(err)
			throw err

		loadedFile = fd,
		loadedFileHeader = await readHeader(fd),
		cachedChunks = await cacheChunks()

		e.reply('file-loaded', loadedFileHeader)
	})

})

ipcMain.on('get-view', (e, start, end, zoomLevel) => {
	const
		resolution = Math.pow(2, zoomLevel),
		nearestLevelIndex = CACHE_LEVELS.length - CACHE_LEVELS.slice().reverse().findIndex(level => level <= zoomLevel) - 1,
		nearestLevelResolution = Math.pow(2, CACHE_LEVELS[nearestLevelIndex]),
		startIndex = Math.round(start/nearestLevelResolution),
		relevantChunk = cachedChunks[nearestLevelIndex].slice(startIndex, startIndex + Math.ceil((end-start)/resolution)*resolution/nearestLevelResolution)

	if(CACHE_LEVELS[nearestLevelIndex] === zoomLevel)
		e.reply('view', relevantChunk)
	else 
		e.reply('view', generateCache(zoomLevel, CACHE_LEVELS[nearestLevelIndex], relevantChunk))
})

ipcMain.on('get-samples', (e, start, end) =>
	fs.read(loadedFile, Buffer.alloc((end-start)*loadedFileHeader.BlockAlign), 0, (end-start)*loadedFileHeader.BlockAlign, loadedFileHeader.DataOffset + start*loadedFileHeader.BlockAlign, (err, bytesRead, buf) =>
		e.reply('samples', buf)))

ipcMain.on('get-analysis', async (e, volumeThreshold, varianceThreshold, lengthThreshold) => {
	lengthThreshold = +lengthThreshold

	const
		pops = [],
		samples = await getSamples(),
		onePerCent = Math.round(samples.length/100)

	for(let i=0; i<samples.length; i++) {
		if(i%onePerCent === 0)
			e.reply('analysis-progress', i, samples.length)

		if(Math.abs(samples[i+1] - samples[i]) > volumeThreshold) {
			let droppedSamples = []

			for(let j=0; j<lengthThreshold; j++) {
				if(Math.abs(samples[i+j+1]) < varianceThreshold)
					droppedSamples.push(samples[i+j+1])
				else break
			}

			if(droppedSamples.length === lengthThreshold)
				pops.push([i, droppedSamples])

			i+=droppedSamples.length
		}
	}

	e.reply('analysis', pops)
})

app.on('ready', () => {
	const mainWindow = new BrowserWindow({
		useContentSize: true,
		webPreferences: {
			nodeIntegration: true
		}
	})

	mainWindow.removeMenu()

	mainWindow.webContents.openDevTools({mode: 'detach'})

	mainWindow.loadFile('index.html')
})