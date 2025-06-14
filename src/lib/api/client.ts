import type {
	PrepareUploadRequest,
	PrepareUploadResponse,
	DubbingPipelineRequest,
	DubbingPipelineResponse,
	DubbingPipelineStatus,
	ApiError as ApiErrorType
} from '$lib/types/api_types';

const API_BASE_URL = 'https://api.blacksmith-lab.com';
const API_TIMEOUT = 30000; // 30 secs

export class ApiClientError extends Error {
	constructor(
		public code: string,
		message: string,
		public status?: number
	) {
		super(message);
		this.name = 'ApiClientError';
	}
}

class ApiClient {
	private readonly baseUrl: string;

	constructor(baseUrl: string = API_BASE_URL) {
		this.baseUrl = baseUrl;
	}

	private async request<T>(
		endpoint: string,
		options: RequestInit = {}
	): Promise<T> {
		const url = `${this.baseUrl}${endpoint}`;

		const config: RequestInit = {
			...options,
			headers: {
				'Content-Type': 'application/json',
				...options.headers,
			},
		};

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT);
		config.signal = controller.signal;

		try {
			const response = await fetch(url, config);
			clearTimeout(timeoutId);

			if (!response.ok) {
				let errorData: ApiErrorType;
				try {
					errorData = await response.json();
				} catch {
					errorData = {
						code: 'UNKNOWN_ERROR',
						message: `HTTP ${response.status}: ${response.statusText}`
					};
				}
				throw new ApiClientError(errorData.code, errorData.message, response.status);
			}

			return await response.json();
		} catch (error) {
			clearTimeout(timeoutId);

			if (error instanceof ApiClientError) {
				throw error;
			}

			if (error instanceof Error) {
				if (error.name === 'AbortError') {
					throw new ApiClientError('TIMEOUT', 'Request timeout');
				}
				throw new ApiClientError('NETWORK_ERROR', `Network error: ${error.message}`);
			}

			throw new ApiClientError('UNKNOWN_ERROR', 'Unknown error occurred');
		}
	}

	async prepareUpload(request: PrepareUploadRequest): Promise<PrepareUploadResponse> {
		console.log('prepareUpload: ', request);
		return this.request<PrepareUploadResponse>('/api/uniframe/dubbing/prepare', {
			method: 'POST',
			body: JSON.stringify(request),
		});
	}

	async uploadFile(
		uploadUrl: string,
		file: File,
		onProgress?: (progress: number) => void
	): Promise<void> {
		return new Promise((resolve, reject) => {
			const xhr = new XMLHttpRequest();

			xhr.upload.onprogress = (event) => {
				if (event.lengthComputable && onProgress) {
					const progress = Math.round((event.loaded / event.total) * 100);
					onProgress(progress);
				}
			};

			xhr.onload = () => {
				if (xhr.status >= 200 && xhr.status < 300) {
					resolve();
				} else {
					reject(new ApiClientError('UPLOAD_FAILED', `Upload failed: ${xhr.statusText}`));
				}
			};

			xhr.onerror = () => {
				reject(new ApiClientError('UPLOAD_ERROR', 'Upload network error'));
			};

			xhr.ontimeout = () => {
				reject(new ApiClientError('UPLOAD_TIMEOUT', 'Upload timeout'));
			};

			xhr.open('PUT', uploadUrl);
			xhr.setRequestHeader('Content-Type', file.type);
			xhr.timeout = 600000; // 10 минут для загрузки больших файлов
			xhr.send(file);
		});
	}


	async startPipeline(request: DubbingPipelineRequest): Promise<DubbingPipelineResponse> {
		return this.request<DubbingPipelineResponse>('/api/uniframe/dubbing/start', {
			method: 'POST',
			body: JSON.stringify(request),
		});
	}
	
	async getPipelineStatus(pipelineId: string): Promise<DubbingPipelineStatus> {
		return this.request<DubbingPipelineStatus>(`/api/uniframe/dubbing/${pipelineId}/status`);
	}

	async pollPipelineStatus(
		pipelineId: string,
		onUpdate: (status: DubbingPipelineStatus) => void,
		onComplete: (status: DubbingPipelineStatus) => void,
		onError: (error: string) => void
	): Promise<void> {
		const pollInterval = 3000;
		let consecutiveErrors = 0;
		const maxConsecutiveErrors = 10;

		const startTime = Date.now();
		const maxDuration = 24 * 60 * 60 * 1000;

		const poll = async () => {
			if (Date.now() - startTime > maxDuration) {
				onError('Pipeline timeout - maximum duration exceeded (24 hours)');
				return;
			}

			try {
				const status = await this.getPipelineStatus(pipelineId);
				consecutiveErrors = 0;
				onUpdate(status);

				if (status.status === 'completed') {
					onComplete(status);
					return;
				}

				if (status.status === 'failed' || status.error_message) {
					onError(status.error_message || 'Pipeline failed');
					return;
				}

				setTimeout(poll, pollInterval);

			} catch (error) {
				consecutiveErrors++;

				if (consecutiveErrors >= maxConsecutiveErrors) {
					if (error instanceof ApiClientError) {
						onError(`Too many consecutive errors: ${error.message}`);
					} else {
						onError('Too many consecutive errors while checking pipeline status');
					}
					return;
				}

				console.warn(`Pipeline status check failed (${consecutiveErrors}/${maxConsecutiveErrors}):`, error);
				const errorInterval = Math.min(pollInterval * consecutiveErrors, 30000); // 3s, 6s, 9s... до 30s
				setTimeout(poll, errorInterval);
			}
		};

		await poll();
	}
}

export const apiClient = new ApiClient();
