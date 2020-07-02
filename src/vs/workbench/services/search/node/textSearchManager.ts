/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { CancellationToken, CancellationTokenSource } from 'vs/base/common/cancellation';
import { toErrorMessage } from 'vs/base/common/errorMessage';
import * as glob from 'vs/base/common/glob';
import * as resources from 'vs/base/common/resources';
import { URI } from 'vs/base/common/uri';
import { TPromise } from 'vs/base/common/winjs.base';
import * as extfs from 'vs/base/node/extfs';
import { IFileMatch, IFolderQuery, IPatternInfo, ISearchCompleteStats, ITextQuery, ITextSearchResult, IExtendedExtensionSearchOptions } from 'vs/platform/search/common/search';
import { QueryGlobTester, resolvePatternsForProvider } from 'vs/workbench/services/search/node/search';
import * as vscode from 'vscode';

export class TextSearchManager {

	private collector: TextSearchResultsCollector;

	private isLimitHit: boolean;
	private resultCount = 0;

	constructor(private query: ITextQuery, private provider: vscode.TextSearchProvider, private _extfs: typeof extfs) {
	}

	public search(onProgress: (matches: IFileMatch[]) => void, token: CancellationToken): TPromise<ISearchCompleteStats> {
		const folderQueries = this.query.folderQueries;
		const tokenSource = new CancellationTokenSource();
		token.onCancellationRequested(() => tokenSource.cancel());

		return new TPromise<ISearchCompleteStats>((resolve, reject) => {
			this.collector = new TextSearchResultsCollector(onProgress);

			let isCanceled = false;
			const onResult = (match: vscode.TextSearchResult, folderIdx: number) => {
				if (isCanceled) {
					return;
				}

				if (this.resultCount >= this.query.maxResults) {
					this.isLimitHit = true;
					isCanceled = true;
					tokenSource.cancel();
				}

				if (!this.isLimitHit) {
					this.resultCount++;
					this.collector.add(match, folderIdx);
				}
			};

			// For each root folder
			TPromise.join(folderQueries.map((fq, i) => {
				return this.searchInFolder(fq, r => onResult(r, i), tokenSource.token);
			})).then(results => {
				tokenSource.dispose();
				this.collector.flush();

				const someFolderHitLImit = results.some(result => result && result.limitHit);
				resolve({
					limitHit: this.isLimitHit || someFolderHitLImit,
					stats: {
						type: 'textSearchProvider'
					}
				});
			}, (errs: Error[]) => {
				tokenSource.dispose();
				const errMsg = errs
					.map(err => toErrorMessage(err))
					.filter(msg => !!msg)[0];

				reject(new Error(errMsg));
			});
		});
	}

	private searchInFolder(folderQuery: IFolderQuery<URI>, onResult: (result: vscode.TextSearchResult) => void, token: CancellationToken): TPromise<vscode.TextSearchComplete> {
		const queryTester = new QueryGlobTester(this.query, folderQuery);
		const testingPs: TPromise<void>[] = [];
		const progress = {
			report: (result: vscode.TextSearchResult) => {
				const hasSibling = folderQuery.folder.scheme === 'file' && glob.hasSiblingPromiseFn(() => {
					return this.readdir(path.dirname(result.uri.fsPath));
				});

				const relativePath = path.relative(folderQuery.folder.fsPath, result.uri.fsPath);
				testingPs.push(
					queryTester.includedInQuery(relativePath, path.basename(relativePath), hasSibling)
						.then(included => {
							if (included) {
								onResult(result);
							}
						}));
			}
		};

		const searchOptions = this.getSearchOptionsForFolder(folderQuery);
		return new TPromise(resolve => process.nextTick(resolve))
			.then(() => this.provider.provideTextSearchResults(patternInfoToQuery(this.query.contentPattern), searchOptions, progress, token))
			.then(result => {
				return TPromise.join(testingPs)
					.then(() => result);
			});
	}

	private readdir(dirname: string): TPromise<string[]> {
		return new TPromise((resolve, reject) => {
			this._extfs.readdir(dirname, (err, files) => {
				if (err) {
					return reject(err);
				}

				resolve(files);
			});
		});
	}

	private getSearchOptionsForFolder(fq: IFolderQuery<URI>): vscode.TextSearchOptions {
		const includes = resolvePatternsForProvider(this.query.includePattern, fq.includePattern);
		const excludes = resolvePatternsForProvider(this.query.excludePattern, fq.excludePattern);

		const options = {
			folder: URI.from(fq.folder),
			excludes,
			includes,
			useIgnoreFiles: !fq.disregardIgnoreFiles,
			useGlobalIgnoreFiles: !fq.disregardGlobalIgnoreFiles,
			followSymlinks: !fq.ignoreSymlinks,
			encoding: fq.fileEncoding,
			maxFileSize: this.query.maxFileSize,
			maxResults: this.query.maxResults,
			previewOptions: this.query.previewOptions
		};
		(<IExtendedExtensionSearchOptions>options).usePCRE2 = this.query.usePCRE2;
		return options;
	}
}

function patternInfoToQuery(patternInfo: IPatternInfo): vscode.TextSearchQuery {
	return <vscode.TextSearchQuery>{
		isCaseSensitive: patternInfo.isCaseSensitive || false,
		isRegExp: patternInfo.isRegExp || false,
		isWordMatch: patternInfo.isWordMatch || false,
		isMultiline: patternInfo.isMultiline || false,
		pattern: patternInfo.pattern
	};
}

export class TextSearchResultsCollector {
	private _batchedCollector: BatchedCollector<IFileMatch>;

	private _currentFolderIdx: number;
	private _currentUri: URI;
	private _currentFileMatch: IFileMatch;

	constructor(private _onResult: (result: IFileMatch[]) => void) {
		this._batchedCollector = new BatchedCollector<IFileMatch>(512, items => this.sendItems(items));
	}

	add(data: vscode.TextSearchResult, folderIdx: number): void {
		// Collects TextSearchResults into IInternalFileMatches and collates using BatchedCollector.
		// This is efficient for ripgrep which sends results back one file at a time. It wouldn't be efficient for other search
		// providers that send results in random order. We could do this step afterwards instead.
		if (this._currentFileMatch && (this._currentFolderIdx !== folderIdx || !resources.isEqual(this._currentUri, data.uri))) {
			this.pushToCollector();
			this._currentFileMatch = null;
		}

		if (!this._currentFileMatch) {
			this._currentFolderIdx = folderIdx;
			this._currentFileMatch = {
				resource: data.uri,
				matches: []
			};
		}

		this._currentFileMatch.matches.push(extensionResultToFrontendResult(data));
	}

	private pushToCollector(): void {
		const size = this._currentFileMatch ?
			this._currentFileMatch.matches.length :
			0;
		this._batchedCollector.addItem(this._currentFileMatch, size);
	}

	flush(): void {
		this.pushToCollector();
		this._batchedCollector.flush();
	}

	private sendItems(items: IFileMatch[]): void {
		this._onResult(items);
	}
}

function extensionResultToFrontendResult(data: vscode.TextSearchResult): ITextSearchResult {
	// Warning: result from RipgrepTextSearchEH has fake vscode.Range. Don't depend on any other props beyond these...
	return {
		preview: {
			match: {
				startLineNumber: data.preview.match.start.line,
				startColumn: data.preview.match.start.character,
				endLineNumber: data.preview.match.end.line,
				endColumn: data.preview.match.end.character
			},
			text: data.preview.text
		},
		range: {
			startLineNumber: data.range.start.line,
			startColumn: data.range.start.character,
			endLineNumber: data.range.end.line,
			endColumn: data.range.end.character
		}
	};
}

/**
 * Collects items that have a size - before the cumulative size of collected items reaches START_BATCH_AFTER_COUNT, the callback is called for every
 * set of items collected.
 * But after that point, the callback is called with batches of maxBatchSize.
 * If the batch isn't filled within some time, the callback is also called.
 */
export class BatchedCollector<T> {
	private static readonly TIMEOUT = 4000;

	// After START_BATCH_AFTER_COUNT items have been collected, stop flushing on timeout
	private static readonly START_BATCH_AFTER_COUNT = 50;

	private totalNumberCompleted = 0;
	private batch: T[] = [];
	private batchSize = 0;
	private timeoutHandle: any;

	constructor(private maxBatchSize: number, private cb: (items: T[]) => void) {
	}

	addItem(item: T, size: number): void {
		if (!item) {
			return;
		}

		this.addItemToBatch(item, size);
	}

	addItems(items: T[], size: number): void {
		if (!items) {
			return;
		}

		this.addItemsToBatch(items, size);
	}

	private addItemToBatch(item: T, size: number): void {
		this.batch.push(item);
		this.batchSize += size;
		this.onUpdate();
	}

	private addItemsToBatch(item: T[], size: number): void {
		this.batch = this.batch.concat(item);
		this.batchSize += size;
		this.onUpdate();
	}

	private onUpdate(): void {
		if (this.totalNumberCompleted < BatchedCollector.START_BATCH_AFTER_COUNT) {
			// Flush because we aren't batching yet
			this.flush();
		} else if (this.batchSize >= this.maxBatchSize) {
			// Flush because the batch is full
			this.flush();
		} else if (!this.timeoutHandle) {
			// No timeout running, start a timeout to flush
			this.timeoutHandle = setTimeout(() => {
				this.flush();
			}, BatchedCollector.TIMEOUT);
		}
	}

	flush(): void {
		if (this.batchSize) {
			this.totalNumberCompleted += this.batchSize;
			this.cb(this.batch);
			this.batch = [];
			this.batchSize = 0;

			if (this.timeoutHandle) {
				clearTimeout(this.timeoutHandle);
				this.timeoutHandle = 0;
			}
		}
	}
}
